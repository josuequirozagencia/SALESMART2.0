import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { campaignAdvisorLimits, campaignRecipients, campaignSettings, campaigns, channelAccounts, contactLists, Database, qrAccounts, RECIPIENT_STATUSES, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type ErrorDetail } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { ContactsService, type ContactFilters } from '../contacts';
import { CustomValuesService, type CustomValues } from '../custom-fields';
import { OrgDirectoryService, OrgMembersService } from '../organizations';
import { dailyLimit } from '../qr';
import { customKeysIn, resolveQuickReply, unknownVariables, variablesIn, type ResolveContext } from '../quick-replies';
import { renderedText, TemplatesService } from '../templates';
import { classify, effectiveDailyCap, estimate } from './audience';
import { MAX_AUDIENCE, MAX_DRAFTS_PER_USER, MIN_GAP_OFFICIAL_S, OFFICIAL_DAILY_CAP, type LaunchDto, type SettingsDto, MIN_GAP_QR_S, type AdvisorLimitDto, type AudienceDto, type CreateCampaignDto, type ListCampaignsQuery, type PreviewDto, type AudienceListDto, type UpdateCampaignDto } from './campaigns.dto';

type Row = typeof campaigns.$inferSelect;

/** Quién consulta, con lo que importa decidir (sale de los permisos verificados del principal, nunca de la petición). */
export interface CampaignAccess {
  readonly userId: string;
  /** `campaigns.view_all`: ve y trabaja las campañas de toda la empresa. También es lo que distingue al administrador (puede declarar permiso para los contactos sin consentimiento definido). */
  readonly viewAll: boolean;
  /** `contacts.view_all`: el alcance de contactos para armar la audiencia (sin él, solo los suyos; ADR-43). */
  readonly contactsViewAll: boolean;
  /** `campaigns.cancel`: puede pausar, reanudar o cancelar las campañas de otras personas. */
  readonly cancelOthers: boolean;
}

export type ChannelKind = 'official' | 'qr';

export interface CampaignCounts {
  total: number;
  by_status: Record<(typeof RECIPIENT_STATUSES)[number], number>;
  /** Acumulados, como en el informe del prototipo: un mensaje leído también fue entregado y enviado. */
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
}

export interface CampaignView {
  id: string;
  name: string;
  status: string;
  status_reason: string | null;
  mode: 'template' | 'text';
  channel: { id: string; name: string; kind: ChannelKind } | null;
  template_id: string | null;
  template_params: Record<string, string>;
  body: string | null;
  /** Otras versiones del texto (solo por QR). */
  body_variants: string[];
  audience: Record<string, unknown>;
  include_unknown_consent: boolean;
  scheduled_at: string | null;
  gap_seconds: number;
  daily_cap: number;
  created_by: { id: string; name: string };
  created_at: string;
  updated_at: string;
  launched_at: string | null;
  finished_at: string | null;
  counts: CampaignCounts;
  /** ¿Se puede editar? (solo un borrador, y solo quien lo creó). */
  can_edit: boolean;
  /** ¿Puede esta persona pausar, reanudar o cancelar? (quien la creó, o quien tiene `campaigns.cancel`; según el estado). */
  can_pause: boolean;
  can_resume: boolean;
  can_cancel: boolean;
}

export interface CampaignList {
  items: CampaignView[];
  next_cursor: string | null;
}

export interface AudiencePreview {
  /** El borrador al que corresponde; null en la vista previa en vivo (aún sin guardar). */
  campaign_id: string | null;
  audience: {
    /** Contactos que el alcance de la persona deja ver y cumplen lo elegido. */
    in_scope: number;
    /** Contactos de la empresa que cumplen lo elegido pero que esta persona no puede ver (solo cuenta; ver «Alcance de tus campañas» del prototipo). */
    out_of_scope: number;
    eligible: number;
    skipped: { revoked: number; excluded: number; no_phone: number; no_consent: number; duplicate: number };
    /** Algunos de los que recibirían el mensaje (sin teléfono: lo mínimo para reconocerlos). */
    sample: Array<{ id: string; name: string }>;
  };
  /** Null mientras no se haya elegido una conexión que la persona pueda usar. */
  limits: { channel_kind: ChannelKind; daily_cap: number; channel_cap: number; advisor_cap: number | null; min_gap_seconds: number } | null;
  estimate: { days: number; first_day_minutes: number } | null;
  /** El mensaje ya con los datos del primer contacto que lo recibiría (vista previa con un contacto real). */
  message: { text: string; missing: string[]; contact: { id: string; name: string } } | null;
  warnings: Array<'official_marketing_cost' | 'qr_unofficial_risk' | 'unknown_consent_included' | 'spans_days'>;
}

export interface ChannelOption {
  id: string;
  name: string;
  kind: ChannelKind;
}

export interface CampaignOptions {
  channels: ChannelOption[];
  limits: { official_daily_cap: number; qr_min_gap_seconds: number; official_min_gap_seconds: number; advisor_daily_cap: number | null; max_audience: number };
}

export interface AdvisorLimitView {
  user_id: string;
  daily_cap: number;
  updated_at: string;
}

const AUDIT = 'campaign';
/** Las opciones de la empresa son una sola fila: la auditoría las identifica con este id fijo. */
const ORG_SETTINGS_ID = '00000000-0000-4000-8000-000000000072';
/** Variables que una campaña puede usar: solo las del contacto (ADR-72). `{{telefono}}`, `{{mi_nombre}}` y `{{empresa}}` de las respuestas rápidas no tienen sentido en un envío masivo. */
const CAMPAIGN_BUILT_IN = new Set(['primer_nombre', 'nombre']);
/** Para comparar textos sin mayúsculas, acentos ni signos (dos versiones que solo difieren en eso son la misma). */
const foldText = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const kindOf = (provider: string): ChannelKind | null => (provider === 'meta_cloud' ? 'official' : provider === 'evolution' ? 'qr' : null);
const encodeCursor = (id: string): string => Buffer.from(id).toString('base64url');
function decodeCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = Buffer.from(raw, 'base64url').toString('utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  return id;
}

/** Lo que define una campaña (guardado o por guardar), ya con todos sus campos, para validar el conjunto. */
interface Composed {
  name: string;
  channelId: string;
  mode: 'template' | 'text';
  templateId: string | null;
  templateParams: Record<string, string>;
  body: string | null;
  bodyVariants: string[];
  audience: AudienceDto;
  includeUnknownConsent: boolean;
  scheduledAt: Date | null;
  gapSeconds: number;
  dailyCap: number;
}

const fromRow = (r: Row): Composed => ({
  name: r.name,
  channelId: r.channelAccountId,
  mode: r.mode as Composed['mode'],
  templateId: r.templateId,
  templateParams: r.templateParams,
  body: r.body,
  bodyVariants: r.bodyVariants,
  audience: r.audience as unknown as AudienceDto,
  includeUnknownConsent: r.includeUnknownConsent,
  scheduledAt: r.scheduledAt,
  gapSeconds: r.gapSeconds,
  dailyCap: r.dailyCap,
});

/**
 * Campañas masivas (v17, ADR-72), rebanada 17.1: borradores, vista previa de la audiencia y topes por asesor. NO envía nada (el envío llega en 17.3 y 17.4). La función `campaigns` del plan se
 * exige en cada operación (se lee de la identidad ANTES de abrir la transacción de negocio). Quien no ve todas las campañas solo ve y toca las que creó (404 uniforme). La auditoría guarda ids,
 * conteos y nombres de variables: nunca el texto del mensaje ni teléfonos.
 */
@Injectable()
export class CampaignsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
  ) {}

  /** 403 si el plan de la empresa no enciende «Campañas». Va ANTES de cualquier transacción de negocio. */
  async assertPlan(): Promise<void> {
    if (!(await this.directory.featureEnabled('campaigns'))) throw new ForbiddenError('PLAN_FEATURE_DISABLED', 'Las campañas masivas no están incluidas en el plan de tu empresa. Pídele a tu administrador que cambie de plan');
  }

  // ── lectura ──────────────────────────────────────────────────────────────

  async options(a: CampaignAccess): Promise<CampaignOptions> {
    await this.assertPlan();
    return this.db.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: channelAccounts.id, name: channelAccounts.name, provider: channelAccounts.provider, createdBy: channelAccounts.createdBy })
        .from(channelAccounts)
        .where(and(isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'), inArray(channelAccounts.provider, ['meta_cloud', 'evolution'])))
        .orderBy(channelAccounts.name);
      const channels = rows.flatMap((r): ChannelOption[] => {
        const kind = kindOf(r.provider);
        // Un asesor usa las conexiones oficiales y la conexión QR que él mismo creó (ADR-72 #7)
        return kind && (a.viewAll || kind === 'official' || r.createdBy === a.userId) ? [{ id: r.id, name: r.name, kind }] : [];
      });
      const advisor = a.viewAll ? null : await this.advisorCap(tx, a.userId);
      return { channels, limits: { official_daily_cap: await this.officialCap(tx), qr_min_gap_seconds: MIN_GAP_QR_S, official_min_gap_seconds: MIN_GAP_OFFICIAL_S, advisor_daily_cap: advisor, max_audience: MAX_AUDIENCE } };
    });
  }

  async list(a: CampaignAccess, q: ListCampaignsQuery): Promise<CampaignList> {
    await this.assertPlan();
    const cursor = decodeCursor(q.cursor);
    const page = await this.db.withTenant(async (tx) => {
      const conds: SQL[] = [isNull(campaigns.deletedAt)];
      if (!a.viewAll || q.mine) conds.push(eq(campaigns.createdBy, a.userId));
      if (q.status) conds.push(eq(campaigns.status, q.status));
      if (cursor) conds.push(lt(campaigns.id, cursor));
      const found = await tx.select().from(campaigns).where(and(...conds)).orderBy(desc(campaigns.id)).limit(q.limit + 1);
      return this.viewMany(tx, a, found.slice(0, q.limit), found.length > q.limit);
    });
    await this.named(page.items);
    return page;
  }

  async get(a: CampaignAccess, id: string): Promise<CampaignView> {
    await this.assertPlan();
    const v = await this.db.withTenant(async (tx) => (await this.viewMany(tx, a, [await this.mine(tx, a, id)], false)).items[0]!);
    await this.named([v]);
    return v;
  }

  // ── escritura ────────────────────────────────────────────────────────────

  /** Crea un BORRADOR. Repetir la misma `Idempotency-Key` devuelve el mismo (`created: false`); la llave de otra persona es un 409. */
  async create(a: CampaignAccess, key: string, input: CreateCampaignDto): Promise<{ campaign: CampaignView; created: boolean }> {
    await this.assertPlan();
    const composed = this.compose(input);
    const out = await this.db.withTenant(async (tx) => {
      const [prior] = await tx.select().from(campaigns).where(eq(campaigns.idempotencyKey, key)).limit(1);
      if (prior) {
        if (prior.createdBy !== a.userId || prior.deletedAt) throw new ConflictError('IDEMPOTENCY_KEY_IN_USE', 'Esa Idempotency-Key ya se usó para otra operación');
        return { campaign: (await this.viewMany(tx, a, [prior], false)).items[0]!, created: false };
      }
      await this.validate(tx, a, composed);
      await this.assertDraftRoom(tx, a);
      const [row] = await tx.insert(campaigns).values({ ...this.fields(composed), createdBy: a.userId, idempotencyKey: key }).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: row!.id, newValue: this.auditShape(composed, 'draft'), source: 'manual' });
      return { campaign: (await this.viewMany(tx, a, [row!], false)).items[0]!, created: true };
    });
    await this.named([out.campaign]);
    return out;
  }

  /** Edita un borrador propio: se junta lo guardado con lo nuevo y se valida el conjunto. */
  async update(a: CampaignAccess, id: string, input: UpdateCampaignDto): Promise<CampaignView> {
    await this.assertPlan();
    const v = await this.db.withTenant(async (tx) => {
      const row = await this.editable(tx, a, id);
      const merged = this.merge(fromRow(row), input);
      await this.validate(tx, a, merged);
      const changed = Object.keys(input);
      const [updated] = await tx.update(campaigns).set({ ...this.fields(merged), updatedAt: new Date() }).where(eq(campaigns.id, id)).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'edited', newValue: { fields: changed, ...this.auditShape(merged, 'draft') }, source: 'manual' });
      return (await this.viewMany(tx, a, [updated!], false)).items[0]!;
    });
    await this.named([v]);
    return v;
  }

  /** Copia una campaña (propia, o cualquiera si ve todas) como un borrador nuevo, sin programación. */
  async duplicate(a: CampaignAccess, id: string, key: string): Promise<{ campaign: CampaignView; created: boolean }> {
    await this.assertPlan();
    const out = await this.db.withTenant(async (tx) => {
      const [prior] = await tx.select().from(campaigns).where(eq(campaigns.idempotencyKey, key)).limit(1);
      if (prior) {
        if (prior.createdBy !== a.userId || prior.deletedAt) throw new ConflictError('IDEMPOTENCY_KEY_IN_USE', 'Esa Idempotency-Key ya se usó para otra operación');
        return { campaign: (await this.viewMany(tx, a, [prior], false)).items[0]!, created: false };
      }
      const src = await this.mine(tx, a, id);
      const copy: Composed = { ...fromRow(src), name: `${src.name} (copia)`.slice(0, 80), scheduledAt: null };
      // Quien copia debe poder usar lo que copia: la conexión y el alcance se vuelven a validar con SUS permisos
      await this.validate(tx, a, copy);
      await this.assertDraftRoom(tx, a);
      const [row] = await tx.insert(campaigns).values({ ...this.fields(copy), createdBy: a.userId, idempotencyKey: key }).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: row!.id, newValue: { ...this.auditShape(copy, 'draft'), duplicated_from: id }, source: 'manual' });
      return { campaign: (await this.viewMany(tx, a, [row!], false)).items[0]!, created: true };
    });
    await this.named([out.campaign]);
    return out;
  }

  /**
   * Vista previa de la audiencia y del mensaje de un borrador, SIN enviar ni guardar nada. Solo para quien creó la campaña: la audiencia se arma con el ALCANCE de contactos de quien la lanza, así
   * que otra persona vería números que no son los de ella (la campaña de un asesor ve solo sus contactos). Una persona ajena recibe el mismo 404 que si no existiera.
   */
  async preview(a: CampaignAccess, id: string): Promise<AudiencePreview> {
    await this.assertPlan();
    return this.db.withTenant(async (tx) => {
      const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt), eq(campaigns.createdBy, a.userId))).limit(1);
      if (!row) throw new NotFoundError();
      const c = fromRow(row);
      return this.buildPreview(tx, a, { ...c, templateId: c.templateId, gapSeconds: c.gapSeconds, dailyCap: c.dailyCap }, id, true);
    });
  }

  /** La misma vista previa EN VIVO, mientras se arma la campaña y antes de guardar el borrador: con lo que haya (la audiencia es lo único obligatorio). */
  async previewDraft(a: CampaignAccess, input: PreviewDto): Promise<AudiencePreview> {
    await this.assertPlan();
    if (input.include_unknown_consent && !a.viewAll) throw new ForbiddenError('CONSENT_DECLARATION_FORBIDDEN', 'Solo el administrador puede incluir contactos sin consentimiento definido');
    return this.db.withTenant((tx) =>
      this.buildPreview(
        tx,
        a,
        {
          audience: input.audience,
          includeUnknownConsent: input.include_unknown_consent ?? false,
          channelId: input.channel_id ?? '',
          mode: input.mode ?? 'text',
          templateId: input.template_id ?? null,
          templateParams: input.template_params ?? {},
          body: input.body ?? null,
          bodyVariants: [],
          gapSeconds: input.gap_seconds ?? 0,
          dailyCap: input.daily_cap ?? 0,
          name: '',
          scheduledAt: null,
        },
        null,
        false,
      ),
    );
  }

  /** Una página de la lista de destinatarios con el estado de cada uno (se escribe / por qué no), para marcar y desmarcar a mano. */
  async audienceList(a: CampaignAccess, input: AudienceListDto): Promise<{ items: Array<{ id: string; name: string; phone: string | null; state: string }>; total: number; next_cursor: string | null }> {
    await this.assertPlan();
    if (input.include_unknown_consent && !a.viewAll) throw new ForbiddenError('CONSENT_DECLARATION_FORBIDDEN', 'Solo el administrador puede incluir contactos sin consentimiento definido');
    const offset = (() => {
      if (!input.cursor) return 0;
      const n = Number(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!Number.isInteger(n) || n < 0) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
      return n;
    })();
    return this.db.withTenant(async (tx) => {
      const aud = await this.contacts.audienceIn(tx, { viewAll: a.contactsViewAll }, this.source(input.audience), MAX_AUDIENCE);
      const out = classify(aud.contacts, { excluded: new Set(input.audience.excluded_contact_ids ?? []), includeUnknownConsent: input.include_unknown_consent ?? false });
      const page = out.states.slice(offset, offset + input.limit);
      const next = offset + input.limit < out.states.length ? Buffer.from(String(offset + input.limit)).toString('base64url') : null;
      return { items: page, total: out.states.length, next_cursor: next };
    });
  }

  /** Las plantillas aprobadas y enviables de una conexión oficial que la persona puede usar (el asesor no tiene `channels.manage`, así que no podría pedirlas de otro modo). */
  async templatesFor(a: CampaignAccess, channelId: string): Promise<{ items: Array<Awaited<ReturnType<TemplatesService['forChannel']>>['items'][number]> }> {
    await this.assertPlan();
    const kind = await this.db.withTenant((tx) => this.usableKind(tx, a, channelId));
    if (kind !== 'official') throw new NotFoundError();
    const list = await this.templates.forChannel(channelId);
    return { items: list.items.filter((t) => t.sendable) };
  }

  /** Qué puede hacer la persona con campañas (para la pantalla y el menú): permisos verificados y si el plan las incluye. */
  async accessInfo(flags: { read: boolean; send: boolean; viewAll: boolean; manageLimits: boolean; manageSettings: boolean; cancelOthers: boolean }): Promise<{ plan_enabled: boolean; read: boolean; send: boolean; view_all: boolean; manage_limits: boolean; manage_settings: boolean; cancel_others: boolean }> {
    return { plan_enabled: await this.directory.featureEnabled('campaigns'), read: flags.read, send: flags.send, view_all: flags.viewAll, manage_limits: flags.manageLimits, manage_settings: flags.manageSettings, cancel_others: flags.cancelOthers };
  }

  /** El tipo de la conexión si está activa y la persona puede usarla para campañas (oficial: cualquiera; QR: la que creó, o cualquiera si ve todo); null si no. */
  private async usableKind(tx: TenantTx, a: CampaignAccess, channelId: string): Promise<ChannelKind | null> {
    const [ch] = await tx.select({ provider: channelAccounts.provider, createdBy: channelAccounts.createdBy }).from(channelAccounts).where(and(eq(channelAccounts.id, channelId), isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'))).limit(1);
    const kind = ch ? kindOf(ch.provider) : null;
    if (!ch || !kind || (!a.viewAll && kind === 'qr' && ch.createdBy !== a.userId)) return null;
    return kind;
  }

  /** Arma la vista previa. `strict`: un borrador guardado con la conexión caída es un 409; en vivo, simplemente no hay límites que mostrar. */
  private async buildPreview(tx: TenantTx, a: CampaignAccess, c: Composed, campaignId: string | null, strict: boolean): Promise<AudiencePreview> {
    const kind = c.channelId ? await this.usableKind(tx, a, c.channelId) : null;
    if (strict && !kind) throw new ConflictError('CHANNEL_UNAVAILABLE', 'La conexión de esta campaña ya no está disponible');
    const aud = await this.contacts.audienceIn(tx, { viewAll: a.contactsViewAll }, this.source(c.audience), MAX_AUDIENCE);
    const out = classify(aud.contacts, { excluded: new Set(c.audience.excluded_contact_ids ?? []), includeUnknownConsent: c.includeUnknownConsent });
    let limits: AudiencePreview['limits'] = null;
    let est: AudiencePreview['estimate'] = null;
    if (kind) {
      const mode = kind === 'qr' ? 'text' : 'template';
      const qrLimit = kind === 'qr' ? await this.qrWarmupLimit(tx, c.channelId) : 0;
      const advisorCap = a.viewAll ? null : await this.advisorCap(tx, a.userId);
      const minGap = kind === 'qr' ? MIN_GAP_QR_S : MIN_GAP_OFFICIAL_S;
      const { cap, channelCap } = effectiveDailyCap({ mode, campaignCap: c.dailyCap > 0 ? c.dailyCap : 10000, advisorCap, qrWarmupLimit: qrLimit, officialCap: await this.officialCap(tx) });
      limits = { channel_kind: kind, daily_cap: cap, channel_cap: channelCap, advisor_cap: advisorCap, min_gap_seconds: minGap };
      est = estimate(out.eligible.length, cap, Math.max(c.gapSeconds, minGap));
    }
    const first = out.eligible[0];
    let message: AudiencePreview['message'] = null;
    if (first && kind && ((kind === 'qr' && c.body) || (kind === 'official' && c.templateId))) {
      try {
        message = await this.messageFor(tx, { ...c, mode: kind === 'qr' ? 'text' : 'template' }, c.templateId, first);
      } catch (e) {
        if (!(e instanceof NotFoundError) && !(e instanceof ConflictError)) throw e; // una plantilla que ya no existe: sin ejemplo, no un error de la vista previa
      }
    }
    const warnings: AudiencePreview['warnings'] = [];
    if (kind === 'official') warnings.push('official_marketing_cost');
    if (kind === 'qr') warnings.push('qr_unofficial_risk');
    if (c.includeUnknownConsent && out.eligible.some((x) => x.consent === 'unknown')) warnings.push('unknown_consent_included');
    if (est && est.days > 1) warnings.push('spans_days');
    return {
      campaign_id: campaignId,
      audience: {
        in_scope: aud.visible,
        out_of_scope: Math.max(0, aud.company - aud.visible),
        eligible: out.eligible.length,
        skipped: { revoked: out.counts.revoked, excluded: out.counts.excluded, no_phone: out.counts.no_phone, no_consent: out.counts.no_consent, duplicate: out.counts.duplicate },
        sample: out.eligible.slice(0, 5).map((x) => ({ id: x.id, name: x.name })),
      },
      limits,
      estimate: est,
      message,
      warnings,
    };
  }

  // ── tope diario por asesor ───────────────────────────────────────────────

  async advisorLimits(): Promise<{ items: AdvisorLimitView[] }> {
    await this.assertPlan();
    const rows = await this.db.withTenant((tx) => tx.select().from(campaignAdvisorLimits).orderBy(campaignAdvisorLimits.userId));
    return { items: rows.map((r) => ({ user_id: r.userId, daily_cap: r.dailyCap, updated_at: r.updatedAt.toISOString() })) };
  }

  /** Fija o cambia el tope diario de un asesor (solo quien administra al equipo; el servidor comprueba que sea una persona de la empresa). */
  async setAdvisorLimit(userId: string, input: AdvisorLimitDto): Promise<AdvisorLimitView> {
    await this.assertPlan();
    if (!(await this.members.canBeAssigned(userId))) throw new NotFoundError();
    const by = TenantContext.current().userId ?? null;
    return this.db.withTenant(async (tx) => {
      const [before] = await tx.select({ cap: campaignAdvisorLimits.dailyCap }).from(campaignAdvisorLimits).where(eq(campaignAdvisorLimits.userId, userId)).limit(1);
      const [row] = await tx
        .insert(campaignAdvisorLimits)
        .values({ userId, dailyCap: input.daily_cap, updatedBy: by })
        .onConflictDoUpdate({ target: [campaignAdvisorLimits.organizationId, campaignAdvisorLimits.userId], set: { dailyCap: input.daily_cap, updatedBy: by, updatedAt: new Date() } })
        .returning();
      await writeAudit(tx, { entityType: 'campaign_advisor_limit', entityId: userId, field: 'daily_cap', oldValue: before?.cap ?? null, newValue: input.daily_cap, source: 'manual' });
      return { user_id: row!.userId, daily_cap: row!.dailyCap, updated_at: row!.updatedAt.toISOString() };
    });
  }

  // ── tope de la empresa ───────────────────────────────────────────────────

  /** El tope diario de la empresa por WhatsApp oficial: el que fijó el administrador o, sin él, el provisional. */
  private async officialCap(tx: TenantTx): Promise<number> {
    const [s] = await tx.select({ cap: campaignSettings.officialDailyCap }).from(campaignSettings).limit(1);
    return s?.cap ?? OFFICIAL_DAILY_CAP;
  }

  async settings(): Promise<{ official_daily_cap: number; default_cap: number }> {
    await this.assertPlan();
    return { official_daily_cap: await this.db.withTenant((tx) => this.officialCap(tx)), default_cap: OFFICIAL_DAILY_CAP };
  }

  /** Fija el tope diario de la empresa por WhatsApp oficial (quien administra las conexiones). Que no supere el nivel de mensajería de Meta del número lo dice Meta al enviar (la campaña se pausa sola), no se valida aquí. */
  async setSettings(input: SettingsDto): Promise<{ official_daily_cap: number; default_cap: number }> {
    await this.assertPlan();
    const by = TenantContext.current().userId ?? null;
    await this.db.withTenant(async (tx) => {
      const [before] = await tx.select({ cap: campaignSettings.officialDailyCap }).from(campaignSettings).limit(1);
      await tx.insert(campaignSettings).values({ officialDailyCap: input.official_daily_cap, updatedBy: by }).onConflictDoUpdate({ target: [campaignSettings.organizationId], set: { officialDailyCap: input.official_daily_cap, updatedBy: by, updatedAt: new Date() } });
      await writeAudit(tx, { entityType: 'campaign_settings', entityId: ORG_SETTINGS_ID, field: 'official_daily_cap', oldValue: before?.cap ?? null, newValue: input.official_daily_cap, source: 'manual' });
    });
    return { official_daily_cap: input.official_daily_cap, default_cap: OFFICIAL_DAILY_CAP };
  }

  // ── lanzar, pausar, reanudar y cancelar ──────────────────────────────────

  /**
   * Lanza una campaña: CONGELA la audiencia (cada contacto queda como destinatario con su teléfono, o como omitido con su motivo) y la deja «en curso» o «programada». Solo quien la creó, con el alcance de
   * contactos de esa persona. Es idempotente: repetirlo (doble clic, reintento de red) devuelve la campaña tal como quedó, sin congelar de nuevo. Por WhatsApp QR exige aceptar el aviso de riesgo y una sesión conectada.
   */
  async launch(a: CampaignAccess, id: string, input: LaunchDto = {}): Promise<{ campaign: CampaignView; created: boolean }> {
    await this.assertPlan();
    const out = await this.db.withTenant(async (tx) => {
      const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt), eq(campaigns.createdBy, a.userId))).for('update').limit(1);
      if (!row) throw new NotFoundError();
      if (row.launchedAt) return { campaign: (await this.viewMany(tx, a, [row], false)).items[0]!, created: false };
      if (row.status !== 'draft') throw new ConflictError('CAMPAIGN_STATE', 'Solo se puede lanzar un borrador');
      const c = fromRow(row);
      await this.validate(tx, a, c);
      const [ch] = await tx.select({ provider: channelAccounts.provider }).from(channelAccounts).where(eq(channelAccounts.id, c.channelId)).limit(1);
      const byQr = ch?.provider === 'evolution';
      if (byQr) {
        // Por WhatsApp QR (no oficial): el aviso de riesgo es obligatorio y la sesión tiene que estar conectada
        if (input.accept_qr_risk !== true) throw new ConflictError('QR_RISK_NOT_ACCEPTED', 'Antes de enviar por WhatsApp QR hay que aceptar el aviso de riesgo: el número puede bloquearse si envías muchos mensajes seguidos');
        const [q] = await tx.select({ state: qrAccounts.state }).from(qrAccounts).where(eq(qrAccounts.channelAccountId, c.channelId)).limit(1);
        if (q?.state !== 'open') throw new ConflictError('QR_SESSION_DOWN', 'La sesión de WhatsApp por QR no está conectada: vuelve a escanear el QR en Configuración › Conexiones y lanza la campaña de nuevo');
      }
      const aud = await this.contacts.audienceIn(tx, { viewAll: a.contactsViewAll }, this.source(c.audience), MAX_AUDIENCE);
      const classified = classify(aud.contacts, { excluded: new Set(c.audience.excluded_contact_ids ?? []), includeUnknownConsent: c.includeUnknownConsent });
      if (classified.eligible.length === 0) throw new ConflictError('NO_RECIPIENTS', 'No hay a quién enviarle: revisa la base elegida, los destinatarios desmarcados y el consentimiento');
      const rows = classified.states.map((s) => ({ campaignId: id, contactId: s.id, phone: s.phone, ...(s.state === 'eligible' ? { status: 'pending' } : { status: 'skipped', skipReason: s.state }) }));
      for (let i = 0; i < rows.length; i += 500) await tx.insert(campaignRecipients).values(rows.slice(i, i + 500)).onConflictDoNothing();
      const now = new Date();
      const [updated] = await tx.update(campaigns).set({ status: c.scheduledAt ? 'scheduled' : 'running', launchedAt: now, nextSendAt: c.scheduledAt ?? now, statusReason: null, updatedAt: now }).where(eq(campaigns.id, id)).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'launched', oldValue: 'draft', newValue: { status: updated!.status, recipients: classified.eligible.length, skipped: classified.counts, scheduled: c.scheduledAt !== null, ...(byQr ? { qr_risk_accepted: true } : {}) }, source: 'manual' });
      return { campaign: (await this.viewMany(tx, a, [updated!], false)).items[0]!, created: true };
    });
    await this.named([out.campaign]);
    return out;
  }

  /** Pausa una campaña en curso o programada. Lo que ya salió queda; lo pendiente espera. Quien la creó o quien tiene `campaigns.cancel`. */
  pause(a: CampaignAccess, id: string): Promise<CampaignView> {
    return this.transition(a, id, 'pause');
  }

  /** Reanuda una campaña pausada (a mano o por un problema de la conexión que ya se arregló). */
  resume(a: CampaignAccess, id: string): Promise<CampaignView> {
    return this.transition(a, id, 'resume');
  }

  /** Cancela: lo ya enviado queda; lo pendiente pasa a «omitido» (cancelada) y no sale. No se puede deshacer. */
  cancel(a: CampaignAccess, id: string): Promise<CampaignView> {
    return this.transition(a, id, 'cancel');
  }

  private async transition(a: CampaignAccess, id: string, action: 'pause' | 'resume' | 'cancel'): Promise<CampaignView> {
    await this.assertPlan();
    const v = await this.db.withTenant(async (tx) => {
      const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt), a.viewAll ? undefined : eq(campaigns.createdBy, a.userId))).for('update').limit(1);
      if (!row) throw new NotFoundError();
      if (row.createdBy !== a.userId && !a.cancelOthers) throw new ForbiddenError('CAMPAIGN_NOT_YOURS', 'Solo quien creó la campaña o un administrador puede pausarla, reanudarla o cancelarla');
      const now = new Date();
      const from = row.status;
      let patch: Partial<typeof campaigns.$inferInsert>;
      if (action === 'pause') {
        if (from !== 'running' && from !== 'scheduled') throw new ConflictError('CAMPAIGN_STATE', 'Solo se puede pausar una campaña en curso o programada');
        patch = { status: 'paused', statusReason: 'Pausada a mano', updatedAt: now };
      } else if (action === 'resume') {
        if (from !== 'paused') throw new ConflictError('CAMPAIGN_STATE', 'Solo se puede reanudar una campaña pausada');
        const later = row.scheduledAt !== null && row.scheduledAt.getTime() > now.getTime();
        patch = { status: later ? 'scheduled' : 'running', statusReason: null, nextSendAt: later ? row.scheduledAt : now, updatedAt: now };
      } else {
        if (from !== 'running' && from !== 'scheduled' && from !== 'paused') throw new ConflictError('CAMPAIGN_STATE', 'Solo se puede cancelar una campaña programada, en curso o pausada');
        patch = { status: 'cancelled', statusReason: null, finishedAt: now, nextSendAt: null, updatedAt: now };
      }
      const [updated] = await tx.update(campaigns).set(patch).where(eq(campaigns.id, id)).returning();
      let cancelled = 0;
      if (action === 'cancel') {
        const done = await tx.update(campaignRecipients).set({ status: 'skipped', skipReason: 'cancelled', updatedAt: now }).where(and(eq(campaignRecipients.campaignId, id), eq(campaignRecipients.status, 'pending'))).returning({ id: campaignRecipients.id });
        cancelled = done.length;
      }
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled', oldValue: from, newValue: { status: updated!.status, by: 'person', ...(action === 'cancel' ? { pending_cancelled: cancelled } : {}) }, source: 'manual' });
      return (await this.viewMany(tx, a, [updated!], false)).items[0]!;
    });
    await this.named([v]);
    return v;
  }

  // ── validación ───────────────────────────────────────────────────────────

  private compose(i: CreateCampaignDto): Composed {
    return {
      name: i.name,
      channelId: i.channel_id,
      mode: i.mode,
      templateId: i.template_id ?? null,
      templateParams: i.template_params ?? {},
      body: i.body ?? null,
      bodyVariants: i.body_variants ?? [],
      audience: i.audience,
      includeUnknownConsent: i.include_unknown_consent ?? false,
      scheduledAt: i.scheduled_at ? new Date(i.scheduled_at) : null,
      gapSeconds: i.gap_seconds,
      dailyCap: i.daily_cap,
    };
  }

  private merge(base: Composed, i: UpdateCampaignDto): Composed {
    return {
      name: i.name ?? base.name,
      channelId: i.channel_id ?? base.channelId,
      mode: i.mode ?? base.mode,
      templateId: i.template_id !== undefined ? i.template_id : base.templateId,
      templateParams: i.template_params ?? base.templateParams,
      body: i.body !== undefined ? i.body : base.body,
      bodyVariants: i.body_variants ?? base.bodyVariants,
      audience: i.audience ?? base.audience,
      includeUnknownConsent: i.include_unknown_consent ?? base.includeUnknownConsent,
      scheduledAt: i.scheduled_at !== undefined ? (i.scheduled_at ? new Date(i.scheduled_at) : null) : base.scheduledAt,
      gapSeconds: i.gap_seconds ?? base.gapSeconds,
      dailyCap: i.daily_cap ?? base.dailyCap,
    };
  }

  private fields(c: Composed) {
    return {
      name: c.name,
      channelAccountId: c.channelId,
      mode: c.mode,
      templateId: c.mode === 'template' ? c.templateId : null,
      templateParams: c.mode === 'template' ? c.templateParams : {},
      body: c.mode === 'text' ? c.body : null,
      bodyVariants: c.mode === 'text' ? c.bodyVariants : [],
      audience: c.audience as unknown as Record<string, unknown>,
      includeUnknownConsent: c.includeUnknownConsent,
      scheduledAt: c.scheduledAt,
      gapSeconds: c.gapSeconds,
      dailyCap: c.dailyCap,
    };
  }

  /** Lo que queda en la auditoría: ids, conteos y nombres de variables; jamás el texto del mensaje ni teléfonos. */
  private auditShape(c: Composed, status: string): Record<string, unknown> {
    return {
      name: c.name,
      status,
      mode: c.mode,
      channel_id: c.channelId,
      template_id: c.templateId,
      audience_source: c.audience.source,
      excluded_count: c.audience.excluded_contact_ids?.length ?? 0,
      include_unknown_consent: c.includeUnknownConsent,
      gap_seconds: c.gapSeconds,
      daily_cap: c.dailyCap,
      scheduled: c.scheduledAt !== null,
      variants: c.bodyVariants.length,
      variables: [...new Set([...variablesIn(c.body ?? ''), ...c.bodyVariants.flatMap((v) => variablesIn(v)), ...Object.values(c.templateParams).flatMap((v) => variablesIn(v))])],
    };
  }

  /** Todas las reglas del conjunto (ADR-72). Los errores dicen el campo y qué hacer. */
  private async validate(tx: TenantTx, a: CampaignAccess, c: Composed): Promise<void> {
    const errors: ErrorDetail[] = [];
    if (c.includeUnknownConsent && !a.viewAll) throw new ForbiddenError('CONSENT_DECLARATION_FORBIDDEN', 'Solo el administrador puede incluir contactos sin consentimiento definido');
    const [ch] = await tx.select({ id: channelAccounts.id, provider: channelAccounts.provider, createdBy: channelAccounts.createdBy }).from(channelAccounts).where(and(eq(channelAccounts.id, c.channelId), isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'))).limit(1);
    const kind = ch ? kindOf(ch.provider) : null;
    if (!ch || !kind || (!a.viewAll && kind === 'qr' && ch.createdBy !== a.userId)) {
      errors.push({ path: 'channel_id', code: 'channel_unavailable', message: 'Elige una conexión de WhatsApp activa que puedas usar para campañas' });
    } else {
      if (kind === 'official' && c.mode !== 'template') errors.push({ path: 'mode', code: 'mode_channel_mismatch', message: 'Por WhatsApp oficial solo se envían plantillas aprobadas' });
      if (kind === 'qr' && c.mode !== 'text') errors.push({ path: 'mode', code: 'mode_channel_mismatch', message: 'Por WhatsApp QR se envía texto libre, sin plantillas' });
      const minGap = kind === 'qr' ? MIN_GAP_QR_S : MIN_GAP_OFFICIAL_S;
      if (c.gapSeconds < minGap) errors.push({ path: 'gap_seconds', code: 'gap_too_short', message: `La pausa mínima entre mensajes es de ${minGap} segundos en esta conexión` });
      const advisorCap = a.viewAll ? null : await this.advisorCap(tx, a.userId);
      const { cap, channelCap } = effectiveDailyCap({ mode: kind === 'qr' ? 'text' : 'template', campaignCap: c.dailyCap, advisorCap, qrWarmupLimit: kind === 'qr' ? await this.qrWarmupLimit(tx, c.channelId) : 0, officialCap: await this.officialCap(tx) });
      if (c.dailyCap > cap) errors.push({ path: 'daily_cap', code: 'cap_exceeded', message: `El máximo por día es ${cap}${advisorCap !== null && advisorCap <= channelCap ? ' (el tope que fijó tu administrador)' : ''}` });
    }
    const active = new Set((await this.custom.labels(tx, 'contact')).map((f) => f.key));
    const checkText = (path: string, text: string): void => {
      for (const v of variablesIn(text)) {
        if (CAMPAIGN_BUILT_IN.has(v)) continue;
        if (unknownVariables(`{{${v}}}`, active).length === 0 && v.startsWith('contact.')) continue;
        errors.push({ path, code: 'unknown_variable', message: `La variable «{{${v}}}» no se puede usar en campañas. Usa {{primer_nombre}}, {{nombre}} o un campo personalizado como {{contact.clave}}` });
      }
    };
    if (c.mode === 'text') {
      if (!c.body) errors.push({ path: 'body', code: 'required', message: 'Escribe el mensaje' });
      else checkText('body', c.body);
      const seen = new Set<string>([foldText(c.body ?? '')]);
      c.bodyVariants.forEach((v, i) => {
        checkText(`body_variants.${i}`, v);
        if (seen.has(foldText(v))) errors.push({ path: `body_variants.${i}`, code: 'duplicate_variant', message: 'Esta versión es igual a otra: cada versión debe ser distinta' });
        seen.add(foldText(v));
      });
      if (c.templateId) errors.push({ path: 'template_id', code: 'not_allowed', message: 'El texto libre no lleva plantilla' });
    } else {
      if (c.body) errors.push({ path: 'body', code: 'not_allowed', message: 'Las plantillas no llevan texto libre' });
      if (c.bodyVariants.length > 0) errors.push({ path: 'body_variants', code: 'not_allowed', message: 'Las versiones del mensaje solo se usan en el texto libre por WhatsApp QR' });
      if (!c.templateId) errors.push({ path: 'template_id', code: 'required', message: 'Elige una plantilla aprobada' });
      else if (ch && kind === 'official') {
        const row = await this.templates.getSendable(tx, c.channelId, c.templateId); // 404 si no es de esa conexión, 409 si ya no se puede enviar
        const wanted = new Set(this.templates.variableIds(row));
        for (const id of wanted) if (!c.templateParams[id]) errors.push({ path: `template_params.${id}`, code: 'required', message: 'Falta el dato de esta variable de la plantilla' });
        for (const [id, v] of Object.entries(c.templateParams)) {
          if (!wanted.has(id)) errors.push({ path: `template_params.${id}`, code: 'unknown_param', message: 'La plantilla no tiene esta variable' });
          else checkText(`template_params.${id}`, v);
        }
      }
    }
    if (c.audience.source === 'list' && c.audience.list_id) {
      const [l] = await tx.select({ id: contactLists.id }).from(contactLists).where(and(eq(contactLists.id, c.audience.list_id), isNull(contactLists.deletedAt), or(eq(contactLists.shared, true), eq(contactLists.ownerId, a.userId)))).limit(1);
      if (!l) errors.push({ path: 'audience.list_id', code: 'list_not_found', message: 'La lista no existe o no es tuya ni está compartida' });
    }
    if (c.scheduledAt) {
      const ms = c.scheduledAt.getTime() - Date.now();
      if (ms < 60_000) errors.push({ path: 'scheduled_at', code: 'in_the_past', message: 'Programa la campaña para dentro de al menos un minuto' });
      if (ms > 90 * 86_400_000) errors.push({ path: 'scheduled_at', code: 'too_far', message: 'No se puede programar a más de 90 días' });
    }
    if (errors.length > 0) throw new ValidationError(errors);
  }

  // ── piezas ───────────────────────────────────────────────────────────────

  private source(a: AudienceDto): { list?: string; filters?: ContactFilters } {
    return a.source === 'list' ? { list: a.list_id! } : a.source === 'filters' ? { filters: a.filters ?? {} } : {};
  }

  /** Tope diario que el administrador fijó a este asesor, o null si no tiene. */
  private async advisorCap(tx: TenantTx, userId: string): Promise<number | null> {
    const [r] = await tx.select({ cap: campaignAdvisorLimits.dailyCap }).from(campaignAdvisorLimits).where(eq(campaignAdvisorLimits.userId, userId)).limit(1);
    return r?.cap ?? null;
  }

  /** El cupo diario del calentamiento de la sesión QR (ADR-72 #4); una conexión sin sesión todavía cuenta como recién conectada. */
  private async qrWarmupLimit(tx: TenantTx, channelId: string): Promise<number> {
    const [q] = await tx.select({ first: qrAccounts.firstConnectedAt, waived: qrAccounts.warmupWaived }).from(qrAccounts).where(eq(qrAccounts.channelAccountId, channelId)).limit(1);
    return dailyLimit(q?.first ?? null, new Date(), q?.waived ?? false);
  }

  private async assertDraftRoom(tx: TenantTx, a: CampaignAccess): Promise<void> {
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(campaigns).where(and(isNull(campaigns.deletedAt), eq(campaigns.createdBy, a.userId), eq(campaigns.status, 'draft')));
    if (n >= MAX_DRAFTS_PER_USER) throw new ConflictError('CAMPAIGN_DRAFT_LIMIT', `Tienes ${MAX_DRAFTS_PER_USER} borradores: borra o lanza alguno antes de crear otro`);
  }

  /** Una campaña de la persona (o cualquiera si ve todas); 404 uniforme si no existe, es de otra empresa o ajena. */
  private async mine(tx: TenantTx, a: CampaignAccess, id: string): Promise<Row> {
    const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt), a.viewAll ? undefined : eq(campaigns.createdBy, a.userId))).limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Un borrador de quien lo creó, con la fila bloqueada (dos ediciones a la vez no se pisan). */
  private async editable(tx: TenantTx, a: CampaignAccess, id: string): Promise<Row> {
    const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt), eq(campaigns.createdBy, a.userId))).for('update').limit(1);
    if (!row) throw new NotFoundError();
    if (row.status !== 'draft') throw new ConflictError('CAMPAIGN_NOT_EDITABLE', 'Solo se puede editar un borrador');
    return row;
  }

  /** El mensaje de la campaña ya con los datos de un contacto real: lo que el destinatario leería. */
  private async messageFor(tx: TenantTx, c: Composed, templateId: string | null, contact: { id: string; name: string; phone: string | null }): Promise<AudiencePreview['message']> {
    const texts = c.mode === 'text' ? [c.body ?? ''] : Object.values(c.templateParams);
    const wanted = new Set(texts.flatMap((t) => customKeysIn(t)));
    const values: CustomValues = wanted.size === 0 ? {} : ((await this.custom.valuesFor(tx, 'contact', [contact.id])).get(contact.id) ?? {});
    const ctx: ResolveContext = { contactName: contact.name, contactPhone: contact.phone, agentName: '', orgName: '', custom: Object.fromEntries(Object.entries(values).filter(([k]) => wanted.has(k))) };
    const missing = new Set<string>();
    const fill = (t: string): string => {
      const r = resolveQuickReply(t, ctx);
      for (const m of r.missing) missing.add(m);
      return r.text;
    };
    if (c.mode === 'text') return { text: fill(c.body ?? ''), missing: [...missing], contact: { id: contact.id, name: contact.name } };
    if (!templateId) return null;
    const row = await this.templates.getSendable(tx, c.channelId, templateId);
    const params = Object.fromEntries(Object.entries(c.templateParams).map(([k, v]) => [k, fill(v)]));
    try {
      return { text: renderedText(this.templates.prepare(row, params).rendered), missing: [...missing], contact: { id: contact.id, name: contact.name } };
    } catch (e) {
      // Un valor que Meta rechazaría (p. ej. vacío) no tumba la vista previa: se muestra lo que falta
      if (e instanceof ValidationError) return { text: '', missing: [...missing], contact: { id: contact.id, name: contact.name } };
      throw e;
    }
  }

  // ── vistas ───────────────────────────────────────────────────────────────

  private async viewMany(tx: TenantTx, a: CampaignAccess, rows: Row[], more: boolean): Promise<CampaignList> {
    const ids = rows.map((r) => r.id);
    const stats = ids.length === 0 ? [] : await tx.select({ campaignId: campaignRecipients.campaignId, status: campaignRecipients.status, n: count() }).from(campaignRecipients).where(inArray(campaignRecipients.campaignId, ids)).groupBy(campaignRecipients.campaignId, campaignRecipients.status);
    const channelIds = [...new Set(rows.map((r) => r.channelAccountId))];
    const channels = channelIds.length === 0 ? [] : await tx.select({ id: channelAccounts.id, name: channelAccounts.name, provider: channelAccounts.provider }).from(channelAccounts).where(inArray(channelAccounts.id, channelIds));
    const chMap = new Map(channels.map((c) => [c.id, c]));
    // Los nombres de las personas viven en identidad: se resuelven fuera de la transacción de negocio (ver `hydrate`)
    const items = rows.map((r): CampaignView => {
      const by = Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0])) as CampaignCounts['by_status'];
      for (const s of stats) if (s.campaignId === r.id) by[s.status as keyof typeof by] = Number(s.n);
      const total = Object.values(by).reduce((x, y) => x + y, 0);
      const replied = by.replied;
      const read = by.read + replied;
      const delivered = by.delivered + read;
      const ch = chMap.get(r.channelAccountId);
      const kind = ch ? kindOf(ch.provider) : null;
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        status_reason: r.statusReason,
        mode: r.mode as 'template' | 'text',
        channel: ch && kind ? { id: ch.id, name: ch.name, kind } : null,
        template_id: r.templateId,
        template_params: r.templateParams,
        body: r.body,
        body_variants: r.bodyVariants,
        audience: r.audience,
        include_unknown_consent: r.includeUnknownConsent,
        scheduled_at: r.scheduledAt?.toISOString() ?? null,
        gap_seconds: r.gapSeconds,
        daily_cap: r.dailyCap,
        created_by: { id: r.createdBy, name: '' },
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
        launched_at: r.launchedAt?.toISOString() ?? null,
        finished_at: r.finishedAt?.toISOString() ?? null,
        counts: { total, by_status: by, sent: by.sent + delivered, delivered, read, replied, failed: by.failed, skipped: by.skipped },
        can_edit: r.status === 'draft' && r.createdBy === a.userId,
        can_pause: (r.createdBy === a.userId || a.cancelOthers) && (r.status === 'running' || r.status === 'scheduled'),
        can_resume: (r.createdBy === a.userId || a.cancelOthers) && r.status === 'paused',
        can_cancel: (r.createdBy === a.userId || a.cancelOthers) && (r.status === 'running' || r.status === 'scheduled' || r.status === 'paused'),
      };
    });
    const last = rows.at(-1);
    return { items, next_cursor: more && last ? encodeCursor(last.id) : null };
  }

  /** Pone los nombres de quienes crearon las campañas (identidad). Se llama FUERA de la transacción de negocio. */
  async named<T extends { created_by: { id: string; name: string } }>(items: T[]): Promise<T[]> {
    const labels = await this.members.labels(items.map((i) => i.created_by.id));
    for (const i of items) i.created_by.name = labels.get(i.created_by.id)?.name ?? '';
    return items;
  }
}
