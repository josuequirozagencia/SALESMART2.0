import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { aiMediaRuns, Database, messageAttachments, messages } from '../../../db';
import { AppError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { AttachmentsService, sniff } from '../../attachments';
import { AiLimitsService, AiModelPricesService, AiPricingService } from '../../platform';
import { AiCreditsService } from '../ai-credits.service';
import { AiGateway, AiUnavailableError } from '../ai-gateway.service';
import { creditsFor } from '../credits';

/** Imágenes que se le entregan al modelo en un turno (ADR-70, decisión 4); las demás se mencionan en una frase. */
export const MAX_IMAGES_PER_TURN = 3;
/** Tamaño máximo de una imagen que se envía al proveedor de IA. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Una imagen que sigue «pendiente» pasado este tiempo desde que llegó el mensaje se da por no disponible (la descarga ya falló o se atoró). */
export const IMAGE_WAIT_MS = 5 * 60_000;

/** Audios que se transcriben en un turno (los más recientes; los demás se mencionan). Antes era 1; el responsable lo cambió el 2026-11-16. */
export const MAX_AUDIOS_PER_TURN = 3;

/** Tamaño máximo de un audio (red de seguridad cuando no se conoce su duración; ADR-70, decisión 3). */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/** Formatos de audio que se transcriben, por su contenido real, con el nombre de archivo que el proveedor reconoce. Un AMR o un AAC suelto no. */
const AUDIO_OF: Record<string, { mime: string; ext: string }> = {
  ogg: { mime: 'audio/ogg', ext: 'ogg' },
  mp3: { mime: 'audio/mpeg', ext: 'mp3' },
  mp4: { mime: 'audio/mp4', ext: 'm4a' },
  webm: { mime: 'audio/webm', ext: 'webm' },
};

/** Un mensaje de audio del cliente pendiente de atender. `transcript` ya viene si se transcribió antes (no se vuelve a cobrar). */
export interface AudioMessage {
  readonly id: string;
  readonly at: Date;
  readonly meta: Record<string, unknown>;
}

export type AudioResult =
  | { readonly status: 'waiting' }
  | { readonly status: 'handoff'; readonly reason: 'media_blocked' | 'daily_limit' | 'audio_too_long' | 'unsupported_media' }
  | { readonly status: 'ready'; readonly lines: string[]; readonly extra: number };

/** Lo que guarda un mensaje de audio ya transcrito, en `messages.meta.transcript`. */
export interface Transcript {
  readonly text: string;
  readonly seconds: number;
  readonly model: string;
  readonly at: string;
}

const cachedTranscript = (meta: Record<string, unknown>): Transcript | null => {
  const t = meta['transcript'];
  if (t === null || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  return typeof o['text'] === 'string' && typeof o['seconds'] === 'number' ? { text: o['text'], seconds: o['seconds'], model: typeof o['model'] === 'string' ? o['model'] : '', at: typeof o['at'] === 'string' ? o['at'] : '' } : null;
};

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
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
  ) {}

  /** ¿Hay un modelo de transcripción con precio cargado? Sin él, los audios siguen yendo a una persona. Se lee ANTES de abrir una transacción de la empresa. */
  async transcriptionAvailable(): Promise<boolean> {
    return (await this.gateway.transcriptionPrice()) !== null;
  }

  /**
   * Los audios del cliente de este turno como texto (ADR-70, S5b; hasta 3 por turno desde el 2026-11-16): los ya transcritos se reutilizan sin cobrar y del resto se transcriben los 3 más recientes (los demás
   * se mencionan). ANTES de gastar nada se resuelve cada adjunto —listo y con el antivirus conforme, formato REAL, 2 MB y la duración que informe el canal (QR) contra el máximo de la plataforma— y, si alguno
   * aún se descarga, se espera. Luego se respeta el tope diario de la empresa y cada transcripción reserva créditos por el máximo de minutos y cobra la duración real (un fallo libera la reserva sin cobrar).
   * Si un audio no se puede leer pero otro sí, el agente atiende lo que sí se escuchó. Nunca se registra el audio ni el texto.
   */
  async transcribeForTurn(input: { agentName: string; agentId: string; conversationId: string; audios: readonly AudioMessage[]; now: Date }): Promise<AudioResult> {
    type Problem = 'media_blocked' | 'daily_limit' | 'audio_too_long' | 'unsupported_media';
    const heard: Array<{ at: number; text: string }> = [];
    const todoAll: AudioMessage[] = [];
    for (const a of [...input.audios].sort((x, y) => x.at.getTime() - y.at.getTime())) {
      const t = cachedTranscript(a.meta);
      if (t) heard.push({ at: a.at.getTime(), text: t.text });
      else todoAll.push(a);
    }
    const targets = todoAll.slice(-MAX_AUDIOS_PER_TURN); // los más recientes
    let notHeard = todoAll.length - targets.length;
    const problems: Problem[] = [];
    const limits = await this.limits.resolve();

    // 1) Preparación sin gastar: qué adjunto sirve y cuál no
    const ready: Array<{ msg: AudioMessage; bytes: Buffer; mime: string; ext: string }> = [];
    for (const target of targets) {
      const hint = typeof target.meta['seconds'] === 'number' ? target.meta['seconds'] : null;
      if (hint !== null && hint > limits.audioMaxSeconds) { problems.push('audio_too_long'); notHeard += 1; continue; }
      const [a] = await this.db.withTenant((tx) =>
        tx
          .select({ state: messageAttachments.state, scan: messageAttachments.scanStatus, key: messageAttachments.storageKey, size: messageAttachments.sizeBytes })
          .from(messageAttachments)
          .where(and(eq(messageAttachments.conversationId, input.conversationId), eq(messageAttachments.direction, 'in'), eq(messageAttachments.messageId, target.id)))
          .limit(1),
      );
      if (!a) { problems.push('media_blocked'); notHeard += 1; continue; }
      if (a.state === 'pending') {
        if (input.now.getTime() - target.at.getTime() < IMAGE_WAIT_MS) return { status: 'waiting' }; // aún se descarga: no se gasta nada todavía
        problems.push('media_blocked'); notHeard += 1; continue;
      }
      if (a.state !== 'ready' || !a.key || !(a.scan === 'clean' || a.scan === 'skipped')) { problems.push('media_blocked'); notHeard += 1; continue; }
      if (a.size === null || a.size > MAX_AUDIO_BYTES) { problems.push('unsupported_media'); notHeard += 1; continue; }
      let bytes: Buffer;
      try {
        bytes = await this.attachments.read(a.key);
      } catch {
        problems.push('media_blocked'); notHeard += 1; continue;
      }
      const sig = sniff(bytes);
      const format = sig ? AUDIO_OF[sig] : undefined;
      if (!format || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) { problems.push('unsupported_media'); notHeard += 1; continue; }
      ready.push({ msg: target, bytes, mime: format.mime, ext: format.ext });
    }

    // 2) Tope diario por empresa (últimas 24 h) y transcripción de lo que sirve, de a uno
    if (ready.length > 0) {
      const since = new Date(input.now.getTime() - 24 * 3_600_000);
      const [used] = await this.db.withTenant((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(aiMediaRuns).where(and(eq(aiMediaRuns.kind, 'audio'), eq(aiMediaRuns.outcome, 'ok'), gte(aiMediaRuns.createdAt, since))));
      let left = Math.max(0, limits.transcriptionsPerDay - (used?.n ?? 0));
      const price = await this.gateway.transcriptionPrice();
      const rate = await this.pricing.resolve(TenantContext.current().organizationId);
      const ref = `Agente ${input.agentName} · audio`.slice(0, 200);
      for (const r of ready) {
        if (left <= 0) { problems.push('daily_limit'); notHeard += 1; continue; }
        if (!price) { problems.push('unsupported_media'); notHeard += 1; continue; }
        left -= 1;
        // Reserva por el máximo de minutos permitido; se cobra la duración real
        const worstUsd = (limits.audioMaxSeconds / 60) * price.usdPerMinute;
        const { holdId } = await this.credits.reserve({ credits: Math.max(1, creditsFor(worstUsd, rate.marginPct, rate.usdPerCredit)), kind: 'use', ref });
        let out;
        try {
          out = await this.gateway.transcribe({ audio: r.bytes, mimeType: r.mime, filename: `audio.${r.ext}` });
        } catch (e) {
          await this.credits.release(holdId);
          throw this.unavailable(e);
        }
        await this.credits.settle(holdId, { costUsd: out.costUsd, ref });
        // La transcripción se guarda en el mensaje (no se vuelve a pedir ni a cobrar) y se anota solo la constancia sin contenido
        const transcript: Transcript = { text: out.text.trim().slice(0, 4000), seconds: out.seconds, model: out.model, at: input.now.toISOString() };
        await this.db.withTenant(async (tx) => {
          await tx.update(messages).set({ meta: sql`${messages.meta} || ${JSON.stringify({ transcript })}::jsonb` }).where(and(eq(messages.id, r.msg.id), eq(messages.conversationId, input.conversationId)));
          await tx.insert(aiMediaRuns).values({ agentId: input.agentId, conversationId: input.conversationId, messageId: r.msg.id, kind: 'audio', mimeType: r.mime, bytes: r.bytes.length, model: out.model, seconds: out.seconds, outcome: 'ok' });
        });
        if (out.seconds > limits.audioMaxSeconds) { problems.push('audio_too_long'); notHeard += 1; continue; }
        if (transcript.text === '') { problems.push('unsupported_media'); notHeard += 1; continue; } // silencio o ruido
        heard.push({ at: r.msg.at.getTime(), text: transcript.text });
      }
    }

    const lines = heard.sort((x, y) => x.at - y.at).map((h) => h.text).filter((t) => t.trim() !== '');
    if (lines.length === 0) return { status: 'handoff', reason: problems[0] ?? 'unsupported_media' };
    return { status: 'ready', lines, extra: notHeard };
  }

  /** Cómo contarle a la tarea que la IA no está disponible (los mismos códigos que el motor de turnos). */
  private unavailable(e: unknown): unknown {
    if (!(e instanceof AiUnavailableError)) return e;
    if (e.code === 'not_configured') return new AppError(503, 'AI_NOT_CONFIGURED', 'El servicio de IA aún no está configurado');
    if (e.code === 'busy') return new AppError(503, 'AI_BUSY', 'El servicio de IA está ocupado');
    return new AppError(502, 'AI_UNAVAILABLE', 'El servicio de IA no está disponible por ahora');
  }

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
