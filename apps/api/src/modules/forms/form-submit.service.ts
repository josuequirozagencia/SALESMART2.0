import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '@sales-smart/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { Database, formFields, forms, formSubmissions, tags, type TenantTx } from '../../db';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { AttributionService } from '../attribution';
import { writeAudit } from '../audit';
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from '../auth';
import { ContactsService } from '../contacts';
import { CustomValuesService } from '../custom-fields';
import { OpportunitiesService } from '../opportunities';
import { FormRoutesService, OrgDirectoryService } from '../organizations';
import { DistributionService } from '../queues';
import { ContactTaggingService } from '../tags';
import { hostOfOrigin, oneLine, originAllowed, validateSubmission, type FieldSpec, type Submission } from './form-model';
import type { PublicSubmitDto } from './forms.dto';

type FormRow = typeof forms.$inferSelect;

/** Lo que la página necesita para dibujar el formulario. Nada interno: ni destino, ni dominios, ni cola. */
export interface PublicForm {
  id: string;
  name: string;
  fields: Array<{ key: string; kind: string; label: string; required: boolean; options: string[] | null; placeholder: string | null }>;
  consent_text: string;
  thanks_message: string;
  redirect_url: string | null;
  captcha: { provider: 'turnstile' | 'fake' | 'none'; site_key: string | null };
}

export interface SubmitResult {
  ok: true;
  event_id: string;
  message: string;
  redirect_url: string | null;
}

interface Loaded {
  form: FormRow;
  fields: FieldSpec[];
}

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
const COOKIE = /^[\w.-]{1,200}$/;
const IDEM = /^[A-Za-z0-9_.:-]{8,100}$/;

/**
 * Recepción PÚBLICA de un formulario (M9.1, ADR-09/54; F07). No hay sesión: la credencial es el token opaco de la URL (que solo permite ENVIAR) y la empresa sale de ahí, nunca del cuerpo.
 * Un token desconocido, un formulario borrado, en borrador o pausado responden lo mismo (404). El `Origin` debe ser uno de los dominios autorizados del formulario (o la propia aplicación): es un
 * freno para páginas ajenas, no una autenticación (cualquiera puede escribir esa cabecera fuera de un navegador); la protección real es el captcha, la trampa, los límites y la validación.
 * Un envío válido **no crea una conversación**: crea o completa el contacto (sin pisar lo que ya tiene), lo deja en la oportunidad, la cola y las etiquetas del formulario y emite el evento Lead.
 * Idempotente por `Idempotency-Key`: reintentar devuelve el mismo resultado sin repetir nada.
 */
@Injectable()
export class FormSubmitService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(FormRoutesService) private readonly routes: FormRoutesService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(ContactTaggingService) private readonly tagging: ContactTaggingService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(AttributionService) private readonly attribution: AttributionService,
    @Inject(DistributionService) private readonly distribution: DistributionService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /**
   * La definición pública del formulario (para dibujarlo). `onAllowed` se llama en cuanto el `Origin` resulta permitido (el controlador pone ahí las cabeceras CORS: así también las respuestas de
   * error posteriores, como un dato inválido, las llevan y la página puede leerlas; un origen NO permitido no las recibe).
   */
  async definition(token: string, origin: string | undefined, onAllowed?: (origin: string) => void): Promise<PublicForm> {
    return this.withForm(token, ({ form, fields }) => {
      this.assertOrigin(form, origin, onAllowed);
      return {
        form: {
          id: token,
          name: form.name,
          fields: fields.map((f) => ({ key: f.key, kind: f.kind, label: f.label, required: f.required, options: f.options ? [...f.options] : null, placeholder: f.placeholder })),
          consent_text: form.consentText,
          thanks_message: form.thanksMessage,
          redirect_url: form.redirectUrl,
          captcha: { provider: this.cfg.signup.captchaProvider, site_key: this.cfg.signup.captchaProvider === 'turnstile' ? (this.cfg.providers.turnstileSiteKey ?? null) : this.cfg.signup.captchaProvider === 'fake' ? 'fake' : null },
        },
      };
    }).then((r) => r.form);
  }

  /** Respuesta al preflight CORS: el origen permitido o 403. */
  async preflight(token: string, origin: string | undefined, onAllowed: (origin: string) => void): Promise<void> {
    await this.withForm(token, ({ form }) => {
      if (!origin) throw new ForbiddenError('ORIGIN_NOT_ALLOWED', 'Este formulario no se puede enviar desde ahí');
      this.assertOrigin(form, origin, onAllowed);
    });
  }

  async submit(token: string, origin: string | undefined, idemKey: string | undefined, body: PublicSubmitDto, meta: { ip: string | null; userAgent: string | null }, onAllowed: (origin: string) => void, now = new Date()): Promise<SubmitResult> {
    if (!idemKey || !IDEM.test(idemKey)) throw new ValidationError([{ path: 'Idempotency-Key', code: 'required', message: 'Falta la cabecera Idempotency-Key (8 a 100 caracteres: letras, números y - _ . :)' }]);
    const route = await this.routes.resolve(token);
    if (!route) throw new NotFoundError();
    return TenantContext.run({ organizationId: route.organizationId }, async () => {
      const loaded = await this.load(route.formId);
      if (!loaded) throw new NotFoundError();
      const { form, fields } = loaded;
      if (!origin) throw new ForbiddenError('ORIGIN_NOT_ALLOWED', 'Este formulario no se puede enviar desde ahí');
      this.assertOrigin(form, origin, onAllowed);
      const reply = (eventId: string): SubmitResult => ({ ok: true, event_id: eventId, message: form.thanksMessage, redirect_url: form.redirectUrl });

      // Campo trampa: lo llenan los programas, no las personas. Se responde «bien» sin guardar nada (para no enseñarle al programa qué lo delató)
      if (body.hp && body.hp.trim() !== '') return reply(`lead:form:${sha256(idemKey).slice(0, 24)}`);

      // Un reintento (misma llave) devuelve lo ya hecho, antes de gastar captcha o trabajo
      const prior = await this.db.withTenant(async (tx) => (await tx.select({ eventId: formSubmissions.eventId }).from(formSubmissions).where(and(eq(formSubmissions.formId, form.id), eq(formSubmissions.idempotencyKey, idemKey))).limit(1))[0] ?? null);
      if (prior) return reply(prior.eventId);

      if (!body.consent) throw new ValidationError([{ path: 'consent', code: 'required', message: 'Debes aceptar el consentimiento para enviar el formulario' }]);
      if (!this.captcha.available) throw new AppError(503, 'CAPTCHA_UNAVAILABLE', 'El formulario no está disponible por ahora');
      if (!body.captcha_token || !(await this.captcha.verify({ token: body.captcha_token, ...(meta.ip ? { ip: meta.ip } : {}) }))) throw new AppError(400, 'CAPTCHA_FAILED', 'No pudimos comprobar que eres una persona: inténtalo de nuevo');
      const checked = validateSubmission(fields, body.values, form.phonePrefix);
      if (!checked.ok) throw new ValidationError(checked.errors);

      const dir = await this.directory.current(); // identidad: ANTES de la transacción de negocio
      try {
        const eventId = await this.db.withTenant((tx) => this.record(tx, form, checked.submission, body, idemKey, meta, dir, now));
        return reply(eventId);
      } catch (e) {
        // Dos envíos con la misma llave a la vez: gana uno; el otro devuelve lo que guardó el primero
        if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
          const again = await this.db.withTenant(async (tx) => (await tx.select({ eventId: formSubmissions.eventId }).from(formSubmissions).where(and(eq(formSubmissions.formId, form.id), eq(formSubmissions.idempotencyKey, idemKey))).limit(1))[0] ?? null);
          if (again) return reply(again.eventId);
        }
        throw e;
      }
    });
  }

  // ------------------------------------------------------------------ interno

  /** Todo lo que pasa con un envío válido, en UNA transacción: o queda todo o no queda nada. */
  private async record(tx: TenantTx, form: FormRow, s: Submission, body: PublicSubmitDto, idemKey: string, meta: { ip: string | null; userAgent: string | null }, dir: { timeZone: string; assignable: ReadonlySet<string> }, now: Date): Promise<string> {
    const { id: contactId, created } = await this.contacts.findOrCreateByPhone(tx, s.phone, 'form', s.name, 'api');
    // Completa lo que falta SIN pisar lo que la empresa ya tiene
    await this.contacts.completeProfile(tx, contactId, { name: s.name, email: s.email }, 'api');
    const filled = Object.keys(s.custom).length > 0 ? await this.custom.fillEmpty(tx, contactId, s.custom) : null;
    if (filled) for (const ch of filled.changes) await this.audit(tx, contactId, ch.key, ch.newValue);
    await this.contacts.grantConsentIfUnknown(tx, contactId, 'api');

    // Responsable: el que ya tiene el contacto (cartera primero) o el que reparte la cola del formulario
    let ownerId = await this.contacts.ownerOf(tx, contactId);
    if (form.queueId) {
      const a = await this.distribution.assignFor(tx, form.queueId, { now, timeZone: dir.timeZone, assignable: dir.assignable }, { contactOwnerId: ownerId });
      if (a.ownerId && !ownerId) {
        await this.contacts.assignOwnerIfNone(tx, contactId, a.ownerId);
        ownerId = a.ownerId;
      }
    }
    await this.opportunities.openForLead(tx, { contactId, pipelineId: form.pipelineId, stageId: form.stageId, ownerId });
    if (form.extraTagId) {
      const [t] = await tx.select({ id: tags.id }).from(tags).where(eq(tags.id, form.extraTagId)).limit(1);
      if (t) await this.tagging.addCustom(tx, contactId, [t.id]);
    }

    // La tabla es de solo inserción: el id se decide antes, para que el evento Lead (que lo lleva en su identificador) y el envío se escriban de una vez
    const submissionId = uuidv7();
    const eventId = body.event_id ?? `lead:form:${submissionId}`;
    await tx.insert(formSubmissions).values({ id: submissionId, formId: form.id, contactId, idempotencyKey: idemKey, payload: s.clean, utm: cleanUtm(body.utm), sourceUrl: cleanUrl(body.source_url), ipHash: meta.ip ? sha256(meta.ip).slice(0, 32) : null, eventId, contactCreated: created });
    await this.attribution.onFormLead(
      tx,
      {
        contactId,
        eventId,
        phone: s.phone,
        email: s.email,
        fbc: body.fbc && COOKIE.test(body.fbc) ? body.fbc : null,
        fbp: body.fbp && COOKIE.test(body.fbp) ? body.fbp : null,
        ip: meta.ip,
        userAgent: meta.userAgent ? oneLine(meta.userAgent, 300) : null,
        sourceUrl: cleanUrl(body.source_url),
        formName: form.name,
      },
      now,
    );
    return eventId;
  }

  /** Cada campo personalizado que el formulario llenó queda en la auditoría del contacto con origen `api`. */
  private async audit(tx: TenantTx, contactId: string, key: string, value: unknown): Promise<void> {
    await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: `custom.${key}`, oldValue: null, newValue: value, source: 'api' });
  }

  private assertOrigin(form: FormRow, origin: string | undefined, onAllowed?: (origin: string) => void): void {
    if (origin === undefined) return; // una navegación o una lectura del mismo sitio no manda `Origin`
    const own = this.cfg.frontend.baseUrl ? hostOfOrigin(this.cfg.frontend.baseUrl) : null;
    const host = hostOfOrigin(origin);
    if (!(host && own && host === own) && !originAllowed(origin, form.allowedDomains)) throw new ForbiddenError('ORIGIN_NOT_ALLOWED', 'Este formulario no se puede enviar desde ese sitio');
    onAllowed?.(origin);
  }

  /** Carga el formulario del token DENTRO del contexto de su empresa; 404 uniforme si no existe, está borrado o no está publicado. */
  private async withForm<T>(token: string, fn: (l: Loaded) => T): Promise<T> {
    const route = await this.routes.resolve(token);
    if (!route) throw new NotFoundError();
    return TenantContext.run({ organizationId: route.organizationId }, async () => {
      const loaded = await this.load(route.formId);
      if (!loaded) throw new NotFoundError();
      return fn(loaded);
    });
  }

  private async load(formId: string): Promise<Loaded | null> {
    return this.db.withTenant(async (tx) => {
      const [form] = await tx.select().from(forms).where(and(eq(forms.id, formId), isNull(forms.deletedAt), eq(forms.status, 'published'))).limit(1);
      if (!form) return null;
      const rows = await tx.select().from(formFields).where(eq(formFields.formId, formId)).orderBy(asc(formFields.position));
      return { form, fields: rows.map((f) => ({ key: f.key, kind: f.kind as FieldSpec['kind'], label: f.label, mapsTo: f.mapsTo, required: f.required, options: f.options, placeholder: f.placeholder })) };
    });
  }
}

/** Parámetros de campaña y de clic que se guardan (los demás se descartan): `utm_*`, `fbclid` y `gclid`, de a lo sumo 200 caracteres y 10 claves. */
export function cleanUtm(utm: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(utm ?? {})) {
    if (Object.keys(out).length >= 10) break;
    const key = k.toLowerCase();
    if (/^(utm_[a-z0-9_]{1,30}|fbclid|gclid)$/.test(key)) out[key] = oneLine(v, 200);
  }
  return out;
}

/** La página de origen: solo http(s) y acotada; lo demás se descarta. */
export function cleanUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}
