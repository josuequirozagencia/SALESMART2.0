import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { channelAccounts, conversations, Database, messageAttachments } from '../../db';
import { AppError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { RealtimeService } from '../realtime';
import { ChannelVault, WHATSAPP_PROVIDER, WhatsAppProviderError, type WhatsAppProvider } from '../channels';
import { AttachmentsService } from './attachments.service';
import { baseMime, MAX_BYTES, type AttachmentKind } from './attachment-rules';
import { createHash } from 'node:crypto';

/** Intentos de descarga de un archivo antes de darlo por fallido. */
export const DOWNLOAD_MAX_ATTEMPTS = 5;
/** Archivos que una pasada descarga por empresa. */
export const DOWNLOAD_BATCH = 10;
/** Mientras se descarga, el adjunto queda «reservado» este tiempo: si el proceso muere, otra pasada lo retoma. */
export const DOWNLOAD_LEASE_MS = 120_000;
/** Los archivos que una persona subió y nadie envió vencen a las 24 h. */
export const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_BATCH = 50;
const MAX_BACKOFF_MS = 10 * 60_000;
const backoff = (attempts: number): number => Math.min(15_000 * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);

const FAILURE_TEXT = {
  unavailable: 'No pudimos descargar el archivo de WhatsApp',
  expired: 'El archivo ya no está disponible en WhatsApp (los archivos de los clientes vencen a los pocos días)',
  too_large: 'El archivo pesa más de lo permitido',
  credentials: 'No se pudo descargar el archivo: la conexión de WhatsApp no tiene credenciales válidas',
  channel: 'No se pudo descargar el archivo: la conexión de WhatsApp está desactivada o desconectada',
  infected: 'El antivirus bloqueó este archivo: contenía un virus',
} as const;

interface Claimed {
  id: string;
  conversationId: string;
  kind: AttachmentKind;
  sourceMediaId: string;
  mimeType: string;
  attempts: number;
}

/**
 * Descarga de los archivos que mandan los clientes (M5.6d, ADR-50). Al llegar el mensaje queda un adjunto `pending` con el identificador del archivo en el proveedor; esta tarea,
 * por empresa y bajo su contexto, lo reserva (un `UPDATE … FOR UPDATE SKIP LOCKED` que solo gana una instancia), lo descarga FUERA de toda transacción, lo pasa por el antivirus y lo guarda
 * bajo `org/<organización>/…`. Un fallo pasajero (proveedor, antivirus o almacenamiento caídos) se reintenta con espera creciente; uno definitivo (el archivo venció, pesa demasiado,
 * está infectado) deja el adjunto `failed` o `infected` con su explicación. Además vence los archivos subidos que nadie envió. Nunca registra el contenido ni el token.
 */
@Injectable()
export class InboundMediaService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ChannelVault) private readonly vault: ChannelVault,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
  ) {}

  /** Una pasada para la empresa del contexto. Devuelve cuántos adjuntos tocó. */
  async runDue(now: Date, batch = DOWNLOAD_BATCH): Promise<number> {
    let touched = 0;
    for (const a of await this.claim(now, batch)) {
      await this.process(a);
      // Listo, fallido o infectado: lo que ve la persona en el mensaje cambió (un reintento pendiente no avisa de más: solo vuelve a pedir)
      this.realtime?.touchHere(a.conversationId);
      touched += 1;
    }
    touched += await this.expireOrphans(now);
    return touched;
  }

  private claim(now: Date, batch: number): Promise<Claimed[]> {
    return this.db.withTenant(async (tx) => {
      const rows = await tx
        .update(messageAttachments)
        .set({ attempts: sql`${messageAttachments.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + DOWNLOAD_LEASE_MS), updatedAt: now })
        .where(
          sql`${messageAttachments.id} IN (SELECT id FROM ${messageAttachments} WHERE direction = 'in' AND state = 'pending' AND source_media_id IS NOT NULL AND next_attempt_at <= ${now.toISOString()}::timestamptz ORDER BY next_attempt_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED)`,
        )
        .returning({ id: messageAttachments.id, conversationId: messageAttachments.conversationId, kind: messageAttachments.kind, sourceMediaId: messageAttachments.sourceMediaId, mimeType: messageAttachments.mimeType, attempts: messageAttachments.attempts });
      return rows.flatMap((r) => (r.sourceMediaId ? [{ ...r, kind: r.kind as AttachmentKind, sourceMediaId: r.sourceMediaId }] : []));
    });
  }

  private async process(a: Claimed): Promise<void> {
    const organizationId = TenantContext.current().organizationId;
    // 1) Credenciales de la conexión por la que llegó
    const creds = await this.db.withTenant(async (tx) => {
      const [row] = await tx
        .select({ channelId: channelAccounts.id, status: channelAccounts.status, deletedAt: channelAccounts.deletedAt, sealed: channelAccounts.credentialsSealed, provider: channelAccounts.provider })
        .from(conversations)
        .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
        .where(eq(conversations.id, a.conversationId))
        .limit(1);
      return row;
    });
    if (!creds || creds.deletedAt !== null || creds.status !== 'active') return this.fail(a.id, FAILURE_TEXT.channel);
    // WhatsApp por QR (M9.6): el archivo llegó DENTRO del aviso y ya está en una clave temporal del almacenamiento (no hay nada que descargar del proveedor ni token por número)
    const inline = creds.provider === 'evolution';
    const token = inline ? 'qr' : creds.sealed ? this.vault.open(creds.channelId, creds.sealed)?.['access_token'] : undefined;
    if (!token) return this.fail(a.id, FAILURE_TEXT.credentials);

    // 2) Descargar, revisar y guardar (fuera de toda transacción)
    try {
      const media = inline ? { bytes: await this.files.read(a.sourceMediaId), mimeType: a.mimeType } : await this.provider.downloadMedia({ accessToken: token }, a.sourceMediaId, MAX_BYTES[a.kind]);
      if (media.bytes.length === 0) return this.fail(a.id, FAILURE_TEXT.unavailable);
      const mime = baseMime(media.mimeType ?? a.mimeType) || a.mimeType;
      const stored = await this.files.scanAndStore(organizationId, a.id, { bytes: media.bytes, mime });
      await this.db.withTenant((tx) =>
        tx
          .update(messageAttachments)
          .set({ state: 'ready', storageKey: stored.key, sizeBytes: media.bytes.length, checksum: createHash('sha256').update(media.bytes).digest('hex'), mimeType: mime, scanStatus: stored.scanStatus, error: null, nextAttemptAt: null, updatedAt: new Date() })
          .where(and(eq(messageAttachments.id, a.id), eq(messageAttachments.state, 'pending'))),
      );
      if (inline) await this.files.remove(a.sourceMediaId); // la clave temporal ya cumplió: el archivo definitivo quedó bajo la clave del adjunto
    } catch (e) {
      await this.handleFailure(a, e);
    }
  }

  private async handleFailure(a: Claimed, e: unknown): Promise<void> {
    if (e instanceof AppError && e.code === 'ATTACHMENT_INFECTED') {
      await this.db.withTenant((tx) =>
        tx.update(messageAttachments).set({ state: 'infected', scanStatus: 'infected', error: FAILURE_TEXT.infected, nextAttemptAt: null, updatedAt: new Date() }).where(and(eq(messageAttachments.id, a.id), eq(messageAttachments.state, 'pending'))),
      );
      return;
    }
    let text: string = FAILURE_TEXT.unavailable;
    let retry = true;
    if (e instanceof WhatsAppProviderError) {
      if (e.code === 'media_unavailable') [text, retry] = [FAILURE_TEXT.expired, false];
      else if (e.code === 'media_rejected') [text, retry] = [FAILURE_TEXT.too_large, false];
      else if (e.code === 'invalid_token' || e.code === 'number_not_found') [text, retry] = [FAILURE_TEXT.credentials, false];
      else if (e.code === 'rejected') retry = false;
    } else if (!(e instanceof AppError)) {
      this.log.error({ attachment_id: a.id, err: e instanceof Error ? e.name : 'desconocido' }, 'error inesperado al descargar un archivo');
    }
    this.log.warn({ attachment_id: a.id, attempts: a.attempts, retry }, 'no se pudo descargar un archivo de WhatsApp');
    if (retry && a.attempts < DOWNLOAD_MAX_ATTEMPTS) {
      await this.db.withTenant((tx) =>
        tx.update(messageAttachments).set({ nextAttemptAt: new Date(Date.now() + backoff(a.attempts)), updatedAt: new Date() }).where(and(eq(messageAttachments.id, a.id), eq(messageAttachments.state, 'pending'))),
      );
      return;
    }
    await this.fail(a.id, text);
  }

  private fail(id: string, text: string): Promise<void> {
    return this.db.withTenant(async (tx) => {
      await tx.update(messageAttachments).set({ state: 'failed', error: text, nextAttemptAt: null, updatedAt: new Date() }).where(and(eq(messageAttachments.id, id), eq(messageAttachments.state, 'pending')));
    });
  }

  /** Vence los archivos que una persona subió y nadie envió en 24 h: se borran del almacenamiento y el adjunto queda `expired`. */
  private async expireOrphans(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_TTL_MS);
    const rows = await this.db.withTenant((tx) =>
      tx
        .update(messageAttachments)
        .set({ state: 'expired', updatedAt: now })
        .where(
          sql`${messageAttachments.id} IN (SELECT id FROM ${messageAttachments} WHERE direction = 'out' AND message_id IS NULL AND state = 'ready' AND created_at < ${cutoff.toISOString()}::timestamptz ORDER BY created_at, id LIMIT ${ORPHAN_BATCH} FOR UPDATE SKIP LOCKED)`,
        )
        .returning({ key: messageAttachments.storageKey }),
    );
    for (const r of rows) if (r.key) await this.files.remove(r.key);
    return rows.length;
  }
}
