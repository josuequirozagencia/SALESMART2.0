import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { channelAccounts, Database, messages, qrAccounts } from '../../db';
import { NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { errorLabel, lidFromJid, parseEvolutionWebhook, phoneFromJid, WebhookEventsService } from '../channels';
import { QrConnectionsService } from './qr-connections.service';
import { QR_SESSION, QrSessionError, type QrSessionProvider } from './qr-session.port';

/** Tope de registros que se leen de Evolution en una pasada (v19 B3): acota memoria y tiempo; si hay más, se avisa. */
export const CATCH_UP_MAX_RECORDS = 1_000;
/** Horas que cubre cada pasada automática y margen que se solapa con la anterior (los avisos pueden llegar fuera de orden). */
export const CATCH_UP_AUTO_HOURS = 48;
/** La PRIMERA pasada de una conexión mira tan atrás como el máximo manual: lo que ya estaba perdido cuando se encendió esta función también se recupera. */
export const CATCH_UP_FIRST_HOURS = 168;
export const CATCH_UP_OVERLAP_MS = 15 * 60_000;
export const CATCH_UP_MAX_HOURS = 168;
const CHUNK = 200;

export interface CatchUpResult {
  /** Mensajes de chats 1:1 que Evolution tenía dentro del periodo. */
  found: number;
  /** Los que no estaban en la plataforma y se pusieron en cola para procesarse (se ven en la bandeja en unos segundos). */
  recovered: number;
  /** Los que ya estaban. */
  existing: number;
  /** Había más mensajes que el tope de lectura: los más viejos del periodo no se leyeron. */
  truncated: boolean;
  hours: number;
}

/** Desde cuándo mirar en una pasada automática: la primera mira 7 días; las demás, lo último que se cubrió (con margen) y nunca más atrás de 48 h. Pura: se prueba sin base. */
export function autoWindowStart(lastCatchUpAt: Date | null, now: Date): Date {
  if (!lastCatchUpAt) return new Date(now.getTime() - CATCH_UP_FIRST_HOURS * 3_600_000);
  return new Date(Math.max(lastCatchUpAt.getTime() - CATCH_UP_OVERLAP_MS, now.getTime() - CATCH_UP_AUTO_HOURS * 3_600_000));
}

/**
 * Evolution solo trae el teléfono (`key.remoteJidAlt`) en algunos mensajes de un mismo contacto `@lid` (ADR-73). Si OTRO registro del mismo `@lid` lo trae, se le pone a los que no: así el contacto se reconoce
 * por su teléfono y no se duplica. Devuelve copias; no toca los registros originales. Pura: se prueba sin base.
 */
export function withKnownPhones(records: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const phoneOf = new Map<string, string>();
  for (const r of records) {
    const k = r['key'];
    if (!isObj(k)) continue;
    const lid = lidFromJid(k['remoteJid']);
    if (lid && phoneFromJid(k['remoteJidAlt']) !== null) phoneOf.set(lid, String(k['remoteJidAlt']));
  }
  return records.map((r) => {
    const k = r['key'];
    if (!isObj(k)) return r;
    const lid = lidFromJid(k['remoteJid']);
    const phone = lid ? phoneOf.get(lid) : undefined;
    return lid && phone && phoneFromJid(k['remoteJidAlt']) === null ? { ...r, key: { ...k, remoteJidAlt: phone } } : r;
  });
}

/**
 * «Ponerse al día» de una sesión de WhatsApp por QR (v19 B3, ADR-54/ADR-50). Los avisos de Evolution pueden perderse (el spike lo comprobó: no hay reintentos) y una sesión que se vuelve a vincular puede
 * traer de golpe lo que WhatsApp tenía pendiente. Esta pieza LEE lo que Evolution guardó en el periodo, descarta lo que la plataforma ya tiene (por `(canal, id del mensaje)`) y pone el resto en la misma cola de
 * avisos que usa el webhook: así entra por el mismo camino y las mismas reglas (contacto, conversación, adjuntos, idempotencia). Lo recuperado se marca como histórico: no avisa al celular de nadie, no dispara
 * automatizaciones ni cronómetros. Los archivos no se recuperan (Evolution no los entrega en esta lectura): el mensaje queda con su tipo. Solo lectura sobre Evolution. Corre bajo el contexto de una empresa.
 */
@Injectable()
export class QrCatchUpService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QR_SESSION) private readonly provider: QrSessionProvider,
    @Inject(QrConnectionsService) private readonly connections: QrConnectionsService,
    @Inject(WebhookEventsService) private readonly events: WebhookEventsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Corre una pasada de la conexión indicada, mirando `hours` horas hacia atrás. Lanza si la conexión no existe o Evolution no responde (lo traduce a un error nuestro). */
  async run(channelAccountId: string, hours: number, now = new Date()): Promise<CatchUpResult> {
    return this.pass(channelAccountId, new Date(now.getTime() - hours * 3_600_000), hours, now, true);
  }

  /** La pasada automática de una conexión (la tarea la llama cada 10 min): ventana corta y, si falla, solo deja constancia. */
  async auto(channelAccountId: string, lastCatchUpAt: Date | null, now: Date): Promise<CatchUpResult | null> {
    const since = autoWindowStart(lastCatchUpAt, now);
    try {
      return await this.pass(channelAccountId, since, Math.ceil((now.getTime() - since.getTime()) / 3_600_000), now, false);
    } catch (e) {
      const label = e instanceof QrSessionError ? e.code : errorLabel(e);
      await this.db.withTenant((tx) => tx.update(qrAccounts).set({ lastCatchUpAt: now, lastCatchUpError: `No se pudo leer de Evolution (${label})` }).where(eq(qrAccounts.channelAccountId, channelAccountId)));
      this.log.warn({ channel_id: channelAccountId, err: label }, 'ponerse al día: no se pudo leer los mensajes de Evolution');
      return null;
    }
  }

  private async pass(channelAccountId: string, since: Date, hours: number, now: Date, rethrow: boolean): Promise<CatchUpResult> {
    const [row] = await this.db.withTenant((tx) =>
      tx
        .select({ instance: qrAccounts.instanceName })
        .from(qrAccounts)
        .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, qrAccounts.organizationId), eq(channelAccounts.id, qrAccounts.channelAccountId)))
        .where(and(eq(qrAccounts.channelAccountId, channelAccountId), isNull(channelAccounts.deletedAt))),
    );
    if (!row) throw new NotFoundError();
    const creds = await this.connections.mustCredentials();
    let recent;
    try {
      recent = await this.provider.listRecentMessages(creds, row.instance, { sinceMs: since.getTime(), maxRecords: CATCH_UP_MAX_RECORDS });
    } catch (e) {
      if (rethrow) throw this.connections.translate(e);
      throw e;
    }

    const records = withKnownPhones(recent.records);
    // Solo los mensajes de chats 1:1 (los grupos, los estados y lo demás los descarta el mismo lector del webhook)
    const candidates: Array<{ raw: Record<string, unknown>; externalId: string; at: number }> = [];
    for (const rec of records) {
      const parsed = parseEvolutionWebhook({ instance: row.instance, event: 'messages.upsert', data: rec }, now);
      for (const e of parsed.events) {
        const m = e.event.messages[0];
        if (m) candidates.push({ raw: e.raw, externalId: m.externalId, at: m.sentAt.getTime() });
      }
    }
    const known = new Set<string>();
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const ids = candidates.slice(i, i + CHUNK).map((c) => c.externalId);
      const found = await this.db.withTenant((tx) => tx.select({ id: messages.externalId }).from(messages).where(and(eq(messages.channelAccountId, channelAccountId), inArray(messages.externalId, ids))));
      for (const f of found) if (f.id) known.add(f.id);
    }
    // Del más viejo al más nuevo: así las conversaciones nacen en el orden en que ocurrieron
    const missing = candidates.filter((c) => !known.has(c.externalId)).sort((a, b) => a.at - b.at);
    let recovered = 0;
    for (const [i, c] of missing.entries()) {
      // Una hora de recepción distinta por aviso (milisegundos aparte) fija el orden en que la tarea los procesa
      const stored = await this.events.store(channelAccountId, row.instance, { __qr: 1, __catchup: 1, instance: row.instance, event: 'messages.upsert', data: c.raw, media_keys: {} }, new Date(now.getTime() + i));
      if (stored) recovered += 1;
    }
    const result: CatchUpResult = { found: candidates.length, recovered, existing: candidates.length - missing.length, truncated: recent.truncated, hours };
    await this.db.withTenant((tx) =>
      tx
        .update(qrAccounts)
        .set({ lastCatchUpAt: now, lastCatchUpFound: result.found, lastCatchUpRecovered: result.recovered, lastCatchUpTruncated: result.truncated, lastCatchUpError: null })
        .where(eq(qrAccounts.channelAccountId, channelAccountId)),
    );
    if (recovered > 0) this.log.info({ channel_id: channelAccountId, found: result.found, recovered, truncated: result.truncated }, 'ponerse al día: mensajes recuperados de Evolution');
    return result;
  }
}
