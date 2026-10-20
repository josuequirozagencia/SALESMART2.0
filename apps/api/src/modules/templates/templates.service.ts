import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { channelAccounts, Database, messageTemplates, whatsappAccounts, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { ChannelVault, WHATSAPP_PROVIDER, WhatsAppProviderError, type NormalizedTemplate, type WhatsAppProvider } from '../channels';
import { analyze, componentsOf, fromRow, prepare, variablesOf, type Prepared, type TemplateVariable } from './template-model';

/** Si lo último sincronizado tiene más que esto, el selector de plantillas de una conversación vuelve a consultar a Meta antes de listar. */
export const STALE_MS = 10 * 60_000;

type Row = typeof messageTemplates.$inferSelect;

export interface TemplateView {
  id: string;
  channel_id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameter_format: string;
  /** Encabezado: su formato y, si es de texto, el texto (con sus variables sin resolver). */
  header: { format: string; text: string | null } | null;
  /** Cuerpo con sus variables sin resolver. */
  body: string;
  footer: string | null;
  buttons: Array<{ type: string; text: string; url: string | null; phone: string | null }>;
  variables: TemplateVariable[];
  /** ¿Se puede enviar desde el Inbox? Si no, `unsupported_reason` dice por qué. */
  sendable: boolean;
  unsupported_reason: string | null;
  rejected_reason: string | null;
  synced_at: string;
}

export interface TemplateList {
  items: TemplateView[];
  /** Cuándo se sincronizó por última vez con Meta (null si nunca). */
  synced_at: string | null;
  /** Si la última sincronización falló, por qué. */
  sync_error: string | null;
}

export interface SyncSummary {
  synced_at: string;
  total: number;
  added: number;
  updated: number;
  removed: number;
}

const view = (r: Row): TemplateView => {
  const t = fromRow(r);
  return {
    id: r.id,
    channel_id: r.channelAccountId,
    name: r.name,
    language: r.language,
    category: r.category,
    status: r.status,
    parameter_format: r.parameterFormat,
    header: t.header ? { format: t.header.format, text: t.header.text } : null,
    body: r.bodyText,
    footer: t.footer,
    buttons: t.buttons.map((b) => ({ type: b.type, text: b.text, url: b.url, phone: b.phone })),
    variables: variablesOf(t),
    sendable: r.sendable,
    unsupported_reason: r.unsupportedReason,
    rejected_reason: r.rejectedReason,
    synced_at: r.syncedAt.toISOString(),
  };
};

/** JSON con las claves ordenadas: PostgreSQL reordena las de un jsonb, así que dos copias iguales se comparan por esto y no por el texto crudo. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Plantillas de WhatsApp (M5.6a, ADR-50): se SINCRONIZAN desde Meta por conexión (a mano, cada 30 min y, para el selector de una conversación, si lo último tiene más de
 * 10 minutos) y se listan; las plantillas se crean y aprueban en Meta, no aquí. Corre dentro del TenantContext de quien llama. La llamada a Meta va FUERA de toda
 * transacción; lo que vuelve se aplica en una sola, bloqueada por conexión. Una plantilla que Meta ya no devuelve se marca borrada (y revive si vuelve). El token sale de la
 * bóveda y nunca se registra.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ChannelVault) private readonly vault: ChannelVault,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Trae las plantillas de la cuenta de WhatsApp Business de la conexión y las aplica. 404 si la conexión no existe o está desconectada. */
  async sync(channelId: string): Promise<SyncSummary> {
    const ch = await this.db.withTenant(async (tx) => {
      const [row] = await tx
        .select({ sealed: channelAccounts.credentialsSealed, wabaId: whatsappAccounts.wabaId })
        .from(channelAccounts)
        .innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
        .where(and(eq(channelAccounts.id, channelId), isNull(channelAccounts.deletedAt), eq(whatsappAccounts.active, true)))
        .limit(1);
      return row;
    });
    if (!ch) throw new NotFoundError();
    const secrets = ch.sealed ? this.vault.open(channelId, ch.sealed) : null;
    const token = secrets?.['access_token'];
    if (!token) throw new ConflictError('CHANNEL_CREDENTIALS_UNREADABLE', 'No se pueden leer las credenciales guardadas. Vuelve a pegar el token en Configuración › Conexiones');

    let list: readonly NormalizedTemplate[];
    try {
      list = await this.provider.listTemplates({ accessToken: token }, ch.wabaId);
    } catch (e) {
      if (!(e instanceof WhatsAppProviderError)) throw e;
      const text = e.code === 'invalid_token' ? 'Meta rechazó el token: genera uno nuevo y pégalo' : e.code === 'number_not_found' ? 'Meta no encontró la cuenta de WhatsApp Business con este token (revisa el WABA ID)' : e.code === 'rate_limited' ? 'Meta limitó las consultas por ahora' : 'Meta no respondió';
      await this.db.withTenant((tx) => tx.update(whatsappAccounts).set({ templatesSyncError: text, updatedAt: new Date() }).where(eq(whatsappAccounts.channelAccountId, channelId)));
      this.log.warn({ channel_id: channelId, code: e.code }, 'no se pudieron sincronizar las plantillas');
      if (e.code === 'invalid_token') throw new ConflictError('CHANNEL_TOKEN_INVALID', text);
      if (e.code === 'number_not_found') throw new ConflictError('CHANNEL_NUMBER_NOT_FOUND', text);
      throw new ServiceUnavailableError('CHANNEL_PROVIDER_UNAVAILABLE', 'No pudimos hablar con Meta en este momento. Inténtalo de nuevo en unos minutos');
    }
    return this.apply(channelId, list);
  }

  private apply(channelId: string, list: readonly NormalizedTemplate[]): Promise<SyncSummary> {
    return this.db.withTenant(async (tx) => {
      // Dos sincronizaciones de la misma conexión a la vez se turnan: la segunda ve lo que dejó la primera
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`templates:${channelId}`}::text || ':' || app_org()::text, 0))`);
      const existing = await tx.select().from(messageTemplates).where(eq(messageTemplates.channelAccountId, channelId));
      const keyOf = (name: string, language: string): string => `${name}\u0000${language}`;
      const byKey = new Map(existing.map((r) => [keyOf(r.name, r.language), r]));
      const now = new Date();
      const seen = new Set<string>();
      let added = 0;
      let updated = 0;
      for (const t of list) {
        const key = keyOf(t.name, t.language);
        if (seen.has(key)) continue;
        seen.add(key);
        const a = analyze(t);
        const values = {
          externalId: t.externalId,
          category: t.category,
          status: t.status,
          parameterFormat: t.parameterFormat,
          components: componentsOf(t),
          bodyText: a.bodyText,
          variables: a.variables as unknown as Array<Record<string, unknown>>,
          sendable: a.sendable,
          unsupportedReason: a.unsupportedReason,
          rejectedReason: t.rejectedReason,
        };
        const cur = byKey.get(key);
        if (!cur) {
          await tx.insert(messageTemplates).values({ channelAccountId: channelId, name: t.name, language: t.language, ...values, syncedAt: now });
          added += 1;
          continue;
        }
        const same =
          cur.deletedAt === null &&
          cur.externalId === values.externalId &&
          cur.category === values.category &&
          cur.status === values.status &&
          cur.parameterFormat === values.parameterFormat &&
          cur.sendable === values.sendable &&
          cur.unsupportedReason === values.unsupportedReason &&
          cur.rejectedReason === values.rejectedReason &&
          cur.bodyText === values.bodyText &&
          stable(cur.components) === stable(values.components) &&
          stable(cur.variables) === stable(values.variables);
        if (same) continue;
        await tx.update(messageTemplates).set({ ...values, deletedAt: null, syncedAt: now, updatedAt: now }).where(eq(messageTemplates.id, cur.id));
        updated += 1;
      }
      let removed = 0;
      for (const r of existing) {
        if (r.deletedAt !== null || seen.has(keyOf(r.name, r.language))) continue;
        await tx.update(messageTemplates).set({ deletedAt: now, updatedAt: now }).where(eq(messageTemplates.id, r.id));
        removed += 1;
      }
      await tx.update(whatsappAccounts).set({ templatesSyncedAt: now, templatesSyncError: null, updatedAt: now }).where(eq(whatsappAccounts.channelAccountId, channelId));
      return { synced_at: now.toISOString(), total: seen.size, added, updated, removed };
    });
  }

  /** Las plantillas vigentes de una conexión (enviables primero), con el estado de la última sincronización. 404 si la conexión no existe. */
  async list(channelId: string): Promise<TemplateList> {
    return this.db.withTenant(async (tx) => {
      const [w] = await tx
        .select({ at: whatsappAccounts.templatesSyncedAt, error: whatsappAccounts.templatesSyncError })
        .from(channelAccounts)
        .innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
        .where(and(eq(channelAccounts.id, channelId), isNull(channelAccounts.deletedAt)))
        .limit(1);
      if (!w) throw new NotFoundError();
      const rows = await tx
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.channelAccountId, channelId), isNull(messageTemplates.deletedAt)))
        .orderBy(sql`${messageTemplates.sendable} DESC`, asc(messageTemplates.name), asc(messageTemplates.language));
      return { items: rows.map(view), synced_at: w.at?.toISOString() ?? null, sync_error: w.error };
    });
  }

  /**
   * Lo que ve el selector de una conversación: las plantillas de SU conexión. Si lo último sincronizado tiene más de 10 minutos (o nunca se sincronizó) vuelve a
   * consultar a Meta antes; si Meta falla se muestra lo que ya hay (el aviso queda en `sync_error`).
   */
  async forChannel(channelId: string): Promise<TemplateList> {
    const at = await this.db.withTenant(async (tx) => (await tx.select({ at: whatsappAccounts.templatesSyncedAt }).from(whatsappAccounts).where(eq(whatsappAccounts.channelAccountId, channelId)).limit(1))[0]?.at ?? null);
    if (at === null || Date.now() - at.getTime() > STALE_MS) {
      try {
        await this.sync(channelId);
      } catch {
        /* mejor esfuerzo: ya quedó anotado en la conexión y se muestra lo que hay */
      }
    }
    return this.list(channelId);
  }

  /** La plantilla vigente y enviable de ESA conexión; 404 si no existe (o es de otra conexión), 409 si ya no se puede enviar. */
  async getSendable(tx: TenantTx, channelId: string, templateId: string): Promise<Row> {
    const [row] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.channelAccountId, channelId), isNull(messageTemplates.deletedAt))).limit(1);
    if (!row) throw new NotFoundError();
    if (!row.sendable) throw new ConflictError('TEMPLATE_NOT_AVAILABLE', row.unsupportedReason ?? 'Esta plantilla no se puede enviar');
    return row;
  }

  /** Valida los valores contra la plantilla y arma el texto y los datos de envío; 400 con el campo que falla. */
  prepare(row: Row, params: Readonly<Record<string, string>>): Prepared {
    const t = fromRow(row);
    const result = prepare(t, variablesOf(t), params);
    if (!result.ok) throw new ValidationError(result.errors.map((e) => ({ path: e.path, code: 'invalid_param', message: e.message })));
    return result.value;
  }

  /**
   * Para la tarea periódica: sincroniza las conexiones activas con credenciales de la empresa del contexto, cada una por separado (una que falla no frena a las demás).
   * Devuelve cuántas se sincronizaron.
   */
  async syncActive(): Promise<number> {
    const channels = await this.db.withTenant((tx) =>
      tx
        .select({ id: channelAccounts.id })
        .from(channelAccounts)
        .innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
        .where(and(isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'), eq(whatsappAccounts.active, true), sql`${channelAccounts.credentialsSealed} IS NOT NULL`)),
    );
    let done = 0;
    for (const c of channels) {
      try {
        await this.sync(c.id);
        done += 1;
      } catch {
        /* queda anotado en la conexión; se reintenta en la siguiente pasada */
      }
    }
    return done;
  }
}
