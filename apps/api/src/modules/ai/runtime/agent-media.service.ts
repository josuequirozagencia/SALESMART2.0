import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { aiMediaRuns, Database, messageAttachments } from '../../../db';
import { AttachmentsService, sniff } from '../../attachments';
import { AiLimitsService, AiModelPricesService } from '../../platform';

/** Imágenes que se le entregan al modelo en un turno (ADR-70, decisión 4); las demás se mencionan en una frase. */
export const MAX_IMAGES_PER_TURN = 3;
/** Tamaño máximo de una imagen que se envía al proveedor de IA. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Una imagen que sigue «pendiente» pasado este tiempo desde que llegó el mensaje se da por no disponible (la descarga ya falló o se atoró). */
export const IMAGE_WAIT_MS = 5 * 60_000;

/** Tipo real de la imagen, por su contenido (nunca por la extensión ni por lo que diga el proveedor). Solo estos tres tipos se leen: un GIF animado o un SVG no. */
const MIME_OF: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export interface MediaImage {
  readonly messageId: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export type ImagePlan =
  /** Algún adjunto todavía se está descargando: el turno espera. */
  | { readonly status: 'waiting' }
  /** Lo que se puede leer (puede ir vacío) y qué pasó con el resto. */
  | { readonly status: 'ready'; readonly images: MediaImage[]; readonly extra: number; readonly blocked: number; readonly unsupported: number };

/**
 * Los medios del cliente que un agente puede leer (ADR-70, S5a: imágenes). Resuelve, DENTRO del servidor y bajo el contexto de la empresa, los adjuntos de los mensajes que se van a contestar: solo
 * adjuntos ENTRANTES de esa conversación, con el archivo guardado (`ready`) y el antivirus conforme (`clean` o `skipped`); el tipo se decide por el contenido real y el tamaño tiene tope. Los bytes viajan
 * del almacenamiento al proveedor en memoria: nunca se entrega una dirección firmada a un tercero ni se escribe nada en disco ni en registros.
 */
@Injectable()
export class AgentMediaService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(AiLimitsService) private readonly limits: AiLimitsService,
    @Inject(AiModelPricesService) private readonly prices: AiModelPricesService,
  ) {}

  /** ¿El modelo del agente entiende imágenes? (precio cargado y marcado con visión). Se lee ANTES de abrir una transacción de la empresa. */
  async modelSeesImages(model: string): Promise<boolean> {
    return (await this.prices.price(model))?.vision === true;
  }

  /** `messages`: los mensajes de imagen pendientes, con la hora a la que llegaron. */
  async prepareImages(conversationId: string, imageMessages: ReadonlyArray<{ id: string; at: Date }>, now: Date): Promise<ImagePlan> {
    if (imageMessages.length === 0) return { status: 'ready', images: [], extra: 0, blocked: 0, unsupported: 0 };
    const rows = await this.db.withTenant((tx) =>
      tx
        .select({ messageId: messageAttachments.messageId, state: messageAttachments.state, scan: messageAttachments.scanStatus, key: messageAttachments.storageKey, size: messageAttachments.sizeBytes })
        .from(messageAttachments)
        .where(and(eq(messageAttachments.conversationId, conversationId), eq(messageAttachments.direction, 'in'), inArray(messageAttachments.messageId, imageMessages.map((m) => m.id)))),
    );
    const byMessage = new Map(rows.map((r) => [r.messageId, r]));
    const usable: Array<{ messageId: string; key: string; at: Date }> = [];
    let blocked = 0;
    let unsupported = 0;
    for (const m of imageMessages) {
      const a = byMessage.get(m.id);
      if (!a) {
        blocked += 1; // sin adjunto: la descarga nunca llegó a registrarse
        continue;
      }
      if (a.state === 'pending') {
        if (now.getTime() - m.at.getTime() < IMAGE_WAIT_MS) return { status: 'waiting' };
        blocked += 1;
        continue;
      }
      if (a.state !== 'ready' || !a.key || !(a.scan === 'clean' || a.scan === 'skipped')) {
        blocked += 1; // fallida, vencida, infectada o sin revisar: nada sale hacia el proveedor
        continue;
      }
      if (a.size === null || a.size > MAX_IMAGE_BYTES) {
        unsupported += 1;
        continue;
      }
      usable.push({ messageId: m.id, key: a.key, at: m.at });
    }
    // Hasta 3 por turno, las más recientes; el resto solo se menciona
    usable.sort((x, y) => y.at.getTime() - x.at.getTime());
    const chosen = usable.slice(0, MAX_IMAGES_PER_TURN).sort((x, y) => x.at.getTime() - y.at.getTime());
    const images: MediaImage[] = [];
    for (const c of chosen) {
      let bytes: Buffer;
      try {
        bytes = await this.attachments.read(c.key);
      } catch {
        blocked += 1;
        continue;
      }
      const signature = sniff(bytes);
      const mime = signature ? MIME_OF[signature] : undefined;
      if (!mime || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        unsupported += 1;
        continue;
      }
      images.push({ messageId: c.messageId, mimeType: mime, bytes });
    }
    return { status: 'ready', images, extra: Math.max(0, usable.length - chosen.length), blocked, unsupported };
  }

  /** ¿Cuántas imágenes más se pueden leer hoy? (últimas 24 h, por empresa; el tope lo fija el Súper Admin). El límite se lee ANTES de abrir la transacción de la empresa. */
  async imagesLeftToday(now: Date): Promise<number> {
    const limit = (await this.limits.resolve()).imagesPerDay;
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const [row] = await this.db.withTenant((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(aiMediaRuns)
        .where(and(eq(aiMediaRuns.kind, 'image'), eq(aiMediaRuns.outcome, 'ok'), gte(aiMediaRuns.createdAt, since))),
    );
    return Math.max(0, limit - (row?.n ?? 0));
  }

  /** Deja constancia (solo metadatos: nunca el contenido) de las imágenes que se leyeron. */
  async record(agentId: string, conversationId: string | null, model: string, images: ReadonlyArray<Pick<MediaImage, 'messageId' | 'mimeType' | 'bytes'> & { messageId: string | null }>, outcome: 'ok' | 'failed'): Promise<void> {
    if (images.length === 0) return;
    await this.db.withTenant((tx) =>
      tx.insert(aiMediaRuns).values(images.map((i) => ({ agentId, conversationId, messageId: i.messageId, kind: 'image', mimeType: i.mimeType, bytes: i.bytes.length, model, outcome }))),
    );
  }
}
