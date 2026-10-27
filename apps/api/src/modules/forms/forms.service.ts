import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { contacts, Database, formFields, forms, formSubmissions, pipelines, pipelineStages, queues, tags, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CustomValuesService } from '../custom-fields';
import { FormRoutesService } from '../organizations';
import { customKeyOf, keyFromLabel, normalizeDomains, validateStructure, type FieldSpec } from './form-model';
import type { CreateFormDto, SetFieldsDto, SubmissionsQuery, UpdateFormDto } from './forms.dto';

/** Formularios que puede tener una empresa. */
export const MAX_FORMS = 50;
const AUDIT = 'form';

export interface FieldView {
  id: string;
  key: string;
  kind: string;
  label: string;
  maps_to: string;
  required: boolean;
  options: string[] | null;
  placeholder: string | null;
}
export interface FormCard {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'paused';
  field_count: number;
  submissions: number;
  last_submission_at: string | null;
  /** El identificador público (solo permite enviar). */
  public_token: string;
  created_at: string;
}
export interface FormDetail extends FormCard {
  queue_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  extra_tag_id: string | null;
  consent_text: string;
  thanks_message: string;
  redirect_url: string | null;
  allowed_domains: string[];
  phone_prefix: string;
  fields: FieldView[];
  /** Qué le falta para poder publicarse (vacío = lista). */
  missing: string[];
}
export interface SubmissionView {
  id: string;
  at: string;
  contact: { id: string; name: string };
  contact_created: boolean;
  source_url: string | null;
  utm: Record<string, string>;
  values: Record<string, unknown>;
}

type FormRow = typeof forms.$inferSelect;
type FieldRow = typeof formFields.$inferSelect;

const bad = (path: string, code: string, message: string): ValidationError => new ValidationError([{ path, code, message }]);
const specOf = (f: FieldRow): FieldSpec => ({ key: f.key, kind: f.kind as FieldSpec['kind'], label: f.label, mapsTo: f.mapsTo, required: f.required, options: f.options, placeholder: f.placeholder });
const fieldView = (f: FieldRow): FieldView => ({ id: f.id, key: f.key, kind: f.kind, label: f.label, maps_to: f.mapsTo, required: f.required, options: f.options, placeholder: f.placeholder });

/**
 * Formularios embebibles de la empresa (M9.1, ADR-09/54; F07): armar el formulario (campos, destino, dominios), publicarlo o pausarlo y ver lo recibido. Solo quien administra formularios
 * (`forms.manage`). El envío público vive en `FormSubmitService`. Cada cambio queda en la auditoría; el borrado es lógico y libera el nombre.
 */
@Injectable()
export class FormsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(FormRoutesService) private readonly routes: FormRoutesService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
  ) {}

  // ------------------------------------------------------------------ lectura

  async list(): Promise<{ items: FormCard[]; limits: { max_forms: number } }> {
    const { rows, counts, fieldCounts } = await this.db.withTenant(async (tx) => {
      const rows = await tx.select().from(forms).where(isNull(forms.deletedAt)).orderBy(asc(forms.createdAt), asc(forms.id));
      const ids = rows.map((r) => r.id);
      const subs = ids.length > 0 ? await tx.select({ formId: formSubmissions.formId, n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${formSubmissions.createdAt})` }).from(formSubmissions).where(inArray(formSubmissions.formId, ids)).groupBy(formSubmissions.formId) : [];
      const fcs = ids.length > 0 ? await tx.select({ formId: formFields.formId, n: sql<number>`count(*)::int` }).from(formFields).where(inArray(formFields.formId, ids)).groupBy(formFields.formId) : [];
      return { rows, counts: new Map(subs.map((s) => [s.formId, s])), fieldCounts: new Map(fcs.map((f) => [f.formId, f.n])) };
    });
    const tokens = await this.tokens(rows.map((r) => r.id));
    return {
      items: rows.map((r) => this.card(r, fieldCounts.get(r.id) ?? 0, counts.get(r.id)?.n ?? 0, counts.get(r.id)?.last ?? null, tokens.get(r.id) ?? '')),
      limits: { max_forms: MAX_FORMS },
    };
  }

  async get(id: string): Promise<FormDetail> {
    const { row, fields, n, last } = await this.db.withTenant(async (tx) => {
      const row = await this.byId(tx, id);
      const fields = await tx.select().from(formFields).where(eq(formFields.formId, id)).orderBy(asc(formFields.position));
      const [s] = await tx.select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${formSubmissions.createdAt})` }).from(formSubmissions).where(eq(formSubmissions.formId, id));
      return { row, fields, n: s?.n ?? 0, last: s?.last ?? null };
    });
    const token = (await this.tokens([id])).get(id) ?? '';
    return { ...this.card(row, fields.length, n, last, token), queue_id: row.queueId, pipeline_id: row.pipelineId, stage_id: row.stageId, extra_tag_id: row.extraTagId, consent_text: row.consentText, thanks_message: row.thanksMessage, redirect_url: row.redirectUrl, allowed_domains: row.allowedDomains, phone_prefix: row.phonePrefix, fields: fields.map(fieldView), missing: this.missing(row, fields) };
  }

  /** Lo recibido por el formulario, lo más reciente primero. */
  async submissions(id: string, q: SubmissionsQuery): Promise<{ items: SubmissionView[]; next_cursor: string | null }> {
    const cur = this.decodeCursor(q.cursor);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, id);
      const conds = [eq(formSubmissions.formId, id), ...(cur ? [or(lt(formSubmissions.createdAt, cur.at), and(eq(formSubmissions.createdAt, cur.at), lt(formSubmissions.id, cur.id)))!] : [])];
      const rows = await tx
        .select({ s: formSubmissions, contactName: contacts.name })
        .from(formSubmissions)
        .innerJoin(contacts, and(eq(contacts.organizationId, formSubmissions.organizationId), eq(contacts.id, formSubmissions.contactId)))
        .where(and(...conds))
        .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(({ s, contactName }) => ({ id: s.id, at: s.createdAt.toISOString(), contact: { id: s.contactId, name: contactName }, contact_created: s.contactCreated, source_url: s.sourceUrl, utm: s.utm, values: s.payload })),
        next_cursor: rows.length > q.limit && last ? Buffer.from(`${last.s.createdAt.toISOString()}|${last.s.id}`).toString('base64url') : null,
      };
    });
  }

  // ------------------------------------------------------------------ crear, cambiar, publicar, borrar

  /** Un formulario nuevo, en borrador y con lo mínimo (nombre, WhatsApp y correo opcional). */
  async create(input: CreateFormDto): Promise<FormDetail> {
    const userId = TenantContext.current().userId ?? null;
    const row = await this.db
      .withTenant(async (tx) => {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(forms).where(isNull(forms.deletedAt));
        if ((n?.n ?? 0) >= MAX_FORMS) throw new ConflictError('FORM_LIMIT', `Llegaste al máximo de ${MAX_FORMS} formularios: borra alguno para crear otro`);
        const [r] = await tx.insert(forms).values({ name: input.name, description: input.description ?? null, createdBy: userId }).returning();
        await tx.insert(formFields).values([
          { formId: r!.id, position: 0, key: 'nombre', kind: 'text', label: 'Nombre', mapsTo: 'name', required: true, placeholder: 'Tu nombre' },
          { formId: r!.id, position: 1, key: 'whatsapp', kind: 'phone', label: 'WhatsApp', mapsTo: 'phone', required: true, placeholder: 'Tu número de WhatsApp' },
          { formId: r!.id, position: 2, key: 'correo', kind: 'email', label: 'Correo', mapsTo: 'email', required: false, placeholder: 'tucorreo@ejemplo.com' },
        ]);
        await writeAudit(tx, { entityType: AUDIT, entityId: r!.id, newValue: { name: r!.name }, source: 'manual' });
        return r!;
      })
      .catch((e: unknown) => {
        throw this.taken(e) ?? e;
      });
    await this.routes.issue(row.id);
    return this.get(row.id);
  }

  async update(id: string, patch: UpdateFormDto): Promise<FormDetail> {
    const domains = patch.allowed_domains !== undefined ? normalizeDomains(patch.allowed_domains) : null;
    if (domains && domains.bad.length > 0) throw bad('allowed_domains', 'invalid_domain', `Estos dominios no son válidos: ${domains.bad.join(', ')}. Escribe solo el dominio, por ejemplo «mi-sitio.com» o «*.mi-sitio.com»`);
    if (patch.redirect_url) {
      const ok = ((): boolean => {
        try {
          const u = new URL(patch.redirect_url);
          return u.protocol === 'https:' && !u.username && !u.password;
        } catch {
          return false;
        }
      })();
      if (!ok) throw bad('redirect_url', 'invalid_url', 'La dirección de redirección debe empezar con https://');
    }
    await this.db
      .withTenant(async (tx) => {
        const cur = await this.byId(tx, id, true);
        await this.assertDestination(tx, { queueId: patch.queue_id, pipelineId: patch.pipeline_id !== undefined ? patch.pipeline_id : cur.pipelineId, stageId: patch.stage_id, extraTagId: patch.extra_tag_id, stageGiven: patch.stage_id !== undefined, pipelineGiven: patch.pipeline_id !== undefined, curStageId: cur.stageId });
        const set: Partial<typeof forms.$inferInsert> = { updatedAt: new Date() };
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const note = <K extends keyof typeof forms.$inferInsert>(field: string, key: K, oldV: unknown, newV: (typeof forms.$inferInsert)[K]): void => {
          if (JSON.stringify(oldV) === JSON.stringify(newV)) return;
          set[key] = newV;
          changes.push({ field, oldValue: oldV, newValue: newV });
        };
        if (patch.name !== undefined) note('name', 'name', cur.name, patch.name);
        if (patch.description !== undefined) note('description', 'description', cur.description, patch.description?.trim() || null);
        if (patch.queue_id !== undefined) note('queue_id', 'queueId', cur.queueId, patch.queue_id);
        if (patch.pipeline_id !== undefined) {
          note('pipeline_id', 'pipelineId', cur.pipelineId, patch.pipeline_id);
          // Cambiar de pipeline sin elegir etapa deja la primera abierta (la etapa de otro pipeline ya no vale)
          if (patch.stage_id === undefined && patch.pipeline_id !== cur.pipelineId) note('stage_id', 'stageId', cur.stageId, null);
        }
        if (patch.stage_id !== undefined) note('stage_id', 'stageId', cur.stageId, patch.stage_id);
        if (patch.extra_tag_id !== undefined) note('extra_tag_id', 'extraTagId', cur.extraTagId, patch.extra_tag_id);
        if (patch.consent_text !== undefined) note('consent_text', 'consentText', { length: cur.consentText.length }, patch.consent_text);
        if (patch.thanks_message !== undefined) note('thanks_message', 'thanksMessage', { length: cur.thanksMessage.length }, patch.thanks_message);
        if (patch.redirect_url !== undefined) note('redirect_url', 'redirectUrl', cur.redirectUrl, patch.redirect_url || null);
        if (domains) note('allowed_domains', 'allowedDomains', cur.allowedDomains, domains.ok);
        if (patch.phone_prefix !== undefined) note('phone_prefix', 'phonePrefix', cur.phonePrefix, patch.phone_prefix);
        if (changes.length === 0) return;
        await tx.update(forms).set(set).where(eq(forms.id, id));
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      })
      .catch((e: unknown) => {
        throw this.taken(e) ?? e;
      });
    return this.get(id);
  }

  /** Reemplaza los campos del formulario (el constructor guarda todo junto, en orden). Valida la estructura entera y que los campos personalizados existan. */
  async setFields(id: string, input: SetFieldsDto): Promise<FormDetail> {
    const taken = new Set(input.fields.flatMap((f) => (f.key ? [f.key] : [])));
    const specs: FieldSpec[] = input.fields.map((f) => {
      const key = f.key ?? keyFromLabel(f.label, taken);
      taken.add(key);
      return { key, kind: f.kind, label: f.label, mapsTo: f.maps_to, required: f.required, options: f.options ?? null, placeholder: f.placeholder?.trim() || null };
    });
    const issues = validateStructure(specs);
    if (issues.length > 0) throw new ValidationError(issues);
    await this.db.withTenant(async (tx) => {
      await this.byId(tx, id, true);
      const vars = specs.flatMap((s) => {
        const k = customKeyOf(s.mapsTo);
        return k ? [k] : [];
      });
      if (vars.length > 0) {
        const have = new Set((await this.custom.contactFields(tx, vars)).map((f) => f.key));
        const missing = vars.filter((k) => !have.has(k));
        if (missing.length > 0) throw bad('fields', 'unknown_field', `Estos campos personalizados no existen o están archivados: ${missing.join(', ')}`);
      }
      const before = await tx.select({ key: formFields.key }).from(formFields).where(eq(formFields.formId, id));
      await tx.delete(formFields).where(eq(formFields.formId, id));
      await tx.insert(formFields).values(specs.map((s, i) => ({ formId: id, position: i, key: s.key, kind: s.kind, label: s.label, mapsTo: s.mapsTo, required: s.required, options: s.options ? [...s.options] : null, placeholder: s.placeholder })));
      await tx.update(forms).set({ updatedAt: new Date() }).where(eq(forms.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'fields', oldValue: { keys: before.map((b) => b.key) }, newValue: { keys: specs.map((s) => s.key) }, source: 'manual' });
    });
    return this.get(id);
  }

  /** Publica el formulario: desde ese momento recibe envíos. Debe estar completo. */
  async publish(id: string): Promise<FormDetail> {
    await this.db.withTenant(async (tx) => {
      const cur = await this.byId(tx, id, true);
      const fields = await tx.select().from(formFields).where(eq(formFields.formId, id)).orderBy(asc(formFields.position));
      const missing = this.missing(cur, fields);
      if (missing.length > 0) throw new ConflictError('FORM_INCOMPLETE', `Antes de publicar: ${missing.join('; ')}`);
      await this.setStatus(tx, cur, 'published');
    });
    return this.get(id);
  }

  /** Pausa el formulario: deja de recibir envíos (la página que lo incrusta muestra que no está disponible). */
  async pause(id: string): Promise<FormDetail> {
    await this.db.withTenant(async (tx) => this.setStatus(tx, await this.byId(tx, id, true), 'paused'));
    return this.get(id);
  }

  /** Borrado lógico: el formulario deja de recibir envíos y libera su nombre; lo recibido queda. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    return this.db.withTenant(async (tx) => {
      const cur = await this.byId(tx, id, true);
      await tx.update(forms).set({ deletedAt: new Date(), status: 'paused', updatedAt: new Date() }).where(eq(forms.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: { deleted: true, name: cur.name }, source: 'manual' });
      return { id, deleted: true as const };
    });
  }

  // ------------------------------------------------------------------ interno

  private card(r: FormRow, fieldCount: number, submissions: number, last: Date | null, token: string): FormCard {
    return { id: r.id, name: r.name, description: r.description, status: r.status as FormCard['status'], field_count: fieldCount, submissions, last_submission_at: last ? new Date(last).toISOString() : null, public_token: token, created_at: r.createdAt.toISOString() };
  }

  /** Los tokens de los formularios; el que falte (creado sin llegar a emitirlo) se emite ahora. */
  private async tokens(ids: readonly string[]): Promise<Map<string, string>> {
    const have = await this.routes.tokensFor(ids);
    for (const id of ids) if (!have.has(id)) have.set(id, await this.routes.issue(id));
    return have;
  }

  /** Qué le falta a un formulario para poder publicarse. */
  private missing(r: FormRow, fields: readonly FieldRow[]): string[] {
    const out: string[] = validateStructure(fields.map(specOf)).map((i) => i.message);
    if (r.allowedDomains.length === 0) out.push('autoriza al menos un dominio desde el que se enviará (por ejemplo «mi-sitio.com»)');
    return out;
  }

  private async setStatus(tx: TenantTx, cur: FormRow, to: 'published' | 'paused'): Promise<void> {
    if (cur.status === to) return;
    await tx.update(forms).set({ status: to, updatedAt: new Date() }).where(eq(forms.id, cur.id));
    await writeAudit(tx, { entityType: AUDIT, entityId: cur.id, field: 'status', oldValue: cur.status, newValue: to, source: 'manual' });
  }

  private async byId(tx: TenantTx, id: string, lock = false): Promise<FormRow> {
    const q = tx.select().from(forms).where(and(eq(forms.id, id), isNull(forms.deletedAt)));
    const [row] = await (lock ? q.for('update') : q).limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Que la cola, el pipeline, la etapa y la etiqueta existan en esta empresa y encajen entre sí. */
  private async assertDestination(tx: TenantTx, d: { queueId: string | null | undefined; pipelineId: string | null; stageId: string | null | undefined; extraTagId: string | null | undefined; stageGiven: boolean; pipelineGiven: boolean; curStageId: string | null }): Promise<void> {
    const issues: ErrorDetail[] = [];
    if (d.queueId) {
      const [q] = await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, d.queueId), isNull(queues.deletedAt))).limit(1);
      if (!q) issues.push({ path: 'queue_id', code: 'not_found', message: 'La cola no existe' });
    }
    if (d.pipelineGiven && d.pipelineId) {
      const [p] = await tx.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.id, d.pipelineId), isNull(pipelines.deletedAt))).limit(1);
      if (!p) issues.push({ path: 'pipeline_id', code: 'not_found', message: 'El pipeline no existe' });
    }
    if (d.stageGiven && d.stageId) {
      if (!d.pipelineId) issues.push({ path: 'stage_id', code: 'needs_pipeline', message: 'Elige primero el pipeline de la etapa' });
      else {
        const [s] = await tx.select({ kind: pipelineStages.kind, hidden: pipelineStages.isHidden }).from(pipelineStages).where(and(eq(pipelineStages.id, d.stageId), eq(pipelineStages.pipelineId, d.pipelineId), isNull(pipelineStages.deletedAt))).limit(1);
        if (!s) issues.push({ path: 'stage_id', code: 'not_found', message: 'La etapa no es de ese pipeline' });
        else if (s.kind !== 'open' || s.hidden) issues.push({ path: 'stage_id', code: 'invalid_stage', message: 'Un lead nuevo empieza en una etapa abierta y visible' });
      }
    }
    if (d.extraTagId) {
      const [t] = await tx.select({ isSystem: tags.isSystem }).from(tags).where(eq(tags.id, d.extraTagId)).limit(1);
      if (!t) issues.push({ path: 'extra_tag_id', code: 'not_found', message: 'La etiqueta no existe' });
      else if (t.isSystem) issues.push({ path: 'extra_tag_id', code: 'system_tag', message: 'Las etiquetas del sistema las pone el sistema: elige una personalizada' });
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  /** El nombre repetido (índice único por empresa) como 409 con un mensaje claro. */
  private taken(e: unknown): ConflictError | null {
    return (e as { cause?: { code?: string } }).cause?.code === '23505' ? new ConflictError('FORM_EXISTS', 'Ya tienes un formulario con ese nombre') : null;
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}

