import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { contactPhones, contacts, Database, type TenantTx } from '../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CustomValuesService } from '../custom-fields';
import type { FieldType } from '../custom-fields/field-types';
import { OrgMembersService } from '../organizations';
import { ContactTaggingService } from '../tags';
import { ContactImportsRepository, type ImportRow } from './contact-imports.repository';
import { DEFAULT_IMPORT_OPTIONS, IMPORT_BATCH, importOptionsSchema, type CreateImportDto, type ImportOptions, type PatchImportDto, type StageRowsDto, type StartImportDto } from './contact-imports.dto';
import { ContactsRepository } from './contacts.repository';
import { csvFile } from './csv';
import { MAX_ROW_PHONES, planRow, type RowPlan } from './import-row';

export interface ImportView {
  id: string;
  file_name: string;
  status: ImportRow['status'];
  total_rows: number;
  staged_rows: number;
  headers: string[];
  mapping: string[];
  options: ImportOptions;
  counts: { created: number; updated: number; skipped: number; rejected: number; pending: number };
  legal_basis_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface ImportPreview {
  total: number;
  new: number;
  duplicates_existing: number;
  duplicates_in_file: number;
  invalid: number;
  /** Las primeras filas inválidas con su motivo. */
  samples: Array<{ row_no: number; reasons: string[] }>;
}

const AUDIT = 'contact_import';
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const optionsOf = (r: ImportRow): ImportOptions => {
  const p = importOptionsSchema.safeParse({ ...DEFAULT_IMPORT_OPTIONS, ...r.options });
  return p.success ? p.data : DEFAULT_IMPORT_OPTIONS;
};
const STATUS_LABEL: Record<string, string> = { rejected: 'Rechazada', skipped: 'Omitida' };

/**
 * Importación de contactos desde CSV (M3.5, ADR-47). El navegador lee el archivo y sube las filas por lotes; la vista previa y el proceso real usan las MISMAS
 * reglas (`planRow`). Se procesa por lotes de 200 filas, reanudable, con un candado por importación. Solo el administrador (`contacts.import`): ve todos los
 * contactos de la empresa, así que la comparación por teléfono es completa. Importar no genera eventos hacia Meta ni etiqueta Lead.
 */
@Injectable()
export class ContactImportsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactImportsRepository) private readonly repo: ContactImportsRepository,
    @Inject(ContactsRepository) private readonly contactsRepo: ContactsRepository,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(ContactTaggingService) private readonly tagging: ContactTaggingService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  async create(input: CreateImportDto): Promise<ImportView> {
    const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...input.options };
    await this.assertOwner(options.owner_id);
    const userId = this.userId();
    const row = await this.db
      .withTenant(async (tx) => {
        await this.assertTag(tx, options.tag_id);
        const known = new Set((await this.custom.labels(tx, 'contact')).map((f) => f.key));
        const bad = input.mapping.filter((m) => m.startsWith('cf:') && !known.has(m.slice(3)));
        if (bad.length > 0) throw new ValidationError(bad.map((m) => ({ path: 'mapping', code: 'unknown_field', message: `El campo «${m.slice(3)}» no existe o está archivado` })));
        const prev = await this.repo.liveByHash(tx, input.file_hash);
        if (prev) throw this.duplicateFile(prev);
        return this.repo.insert(tx, { fileName: input.file_name, fileHash: input.file_hash, totalRows: input.total_rows, headers: input.headers, mapping: input.mapping, options, createdBy: userId });
      })
      .catch((e: unknown) => {
        const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
        if (cause?.code === '23505' && cause.constraint === 'contact_imports_org_hash_uq') throw new ConflictError('IMPORT_DUPLICATE_FILE', 'Este archivo ya se está importando o ya se importó');
        throw e;
      });
    return this.view(row, {});
  }

  async stage(id: string, input: StageRowsDto): Promise<ImportView> {
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id, true);
      if (imp.status !== 'staging') throw new ConflictError('IMPORT_NOT_STAGING', 'Esta importación ya no recibe filas');
      const staged = await this.repo.stagedCount(tx, id);
      const last = input.from + input.rows.length - 1;
      if (input.from > staged + 1) throw new ConflictError('IMPORT_ROW_OUT_OF_ORDER', `Faltan las filas ${staged + 1} a ${input.from - 1}: súbelas en orden`);
      if (last > imp.totalRows) throw new ValidationError([{ path: 'rows', code: 'too_many', message: `El archivo declaró ${imp.totalRows} filas` }]);
      const wrong = input.rows.findIndex((r) => r.length !== imp.headers.length);
      if (wrong >= 0) throw new ValidationError([{ path: `rows.${wrong}`, code: 'columns', message: `La fila ${input.from + wrong} no tiene ${imp.headers.length} columnas` }]);
      // Un lote repetido (reintento tras un corte de red) no duplica: solo entra lo que aún no estaba
      const fresh = input.rows.map((data, i) => ({ rowNo: input.from + i, data })).filter((r) => r.rowNo > staged);
      if (fresh.length > 0) await this.repo.insertRows(tx, id, fresh);
      const now = staged + fresh.length;
      const row = now >= imp.totalRows ? await this.repo.update(tx, id, { status: 'ready' }) : imp;
      return this.view(row, { pending: now });
    });
  }

  async get(id: string): Promise<ImportView> {
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id);
      return this.view(imp, await this.repo.statusCounts(tx, id));
    });
  }

  async list(): Promise<{ items: ImportView[] }> {
    return this.db.withTenant(async (tx) => {
      const rows = await this.repo.recent(tx, 20);
      const items: ImportView[] = [];
      for (const r of rows) items.push(this.view(r, await this.repo.statusCounts(tx, r.id)));
      return { items };
    });
  }

  /** Vista previa con las mismas reglas del proceso: nuevos, duplicados (contra la empresa y dentro del archivo) e inválidas con su motivo. */
  async preview(id: string): Promise<ImportPreview> {
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id);
      if (imp.status !== 'ready') throw new ConflictError('IMPORT_NOT_READY', 'Primero hay que subir todas las filas del archivo');
      const opts = optionsOf(imp);
      const { types, validate } = await this.rules(tx);
      const rows = await this.repo.pending(tx, id);
      const plans = rows.map((r) => ({ rowNo: r.rowNo, plan: this.plan(r.data ?? [], imp, opts, types, validate) }));
      const existing = await this.repo.contactsByPhones(tx, [...new Set(plans.flatMap((p) => p.plan.phones))]);
      const out: ImportPreview = { total: rows.length, new: 0, duplicates_existing: 0, duplicates_in_file: 0, invalid: 0, samples: [] };
      const seen = new Set<string>();
      for (const { rowNo, plan } of plans) {
        if (plan.errors.length > 0) {
          out.invalid += 1;
          if (out.samples.length < 20) out.samples.push({ row_no: rowNo, reasons: plan.errors });
        } else if (plan.phones.some((p) => existing.has(p))) out.duplicates_existing += 1;
        else if (plan.phones.some((p) => seen.has(p))) out.duplicates_in_file += 1;
        else out.new += 1;
        if (plan.errors.length === 0) for (const p of plan.phones) seen.add(p);
      }
      return out;
    });
  }

  async patch(id: string, input: PatchImportDto): Promise<ImportView> {
    const wantsOwner = input.options.owner_id;
    if (wantsOwner) await this.assertOwner(wantsOwner);
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id, true);
      if (imp.status !== 'staging' && imp.status !== 'ready') throw new ConflictError('IMPORT_LOCKED', 'Las opciones ya no se pueden cambiar');
      const next: ImportOptions = { ...optionsOf(imp), ...input.options };
      await this.assertTag(tx, next.tag_id);
      const row = await this.repo.update(tx, id, { options: next });
      return this.view(row, await this.repo.statusCounts(tx, id));
    });
  }

  /** Confirma y deja la importación lista para procesar. Importar «con consentimiento» exige confirmar la base legal (queda registrado). */
  async start(id: string, input: StartImportDto): Promise<ImportView> {
    const userId = this.userId();
    const imp0 = await this.get(id);
    if (imp0.options.owner_id) await this.assertOwner(imp0.options.owner_id);
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id, true);
      if (imp.status !== 'ready') throw new ConflictError('IMPORT_NOT_READY', imp.status === 'staging' ? 'Primero hay que subir todas las filas del archivo' : 'Esta importación ya empezó o se cerró');
      const opts = optionsOf(imp);
      if (opts.consent === 'granted' && input.legal_basis !== true) throw new ValidationError([{ path: 'legal_basis', code: 'required', message: 'Confirma que tienes base legal para contactar a estas personas' }]);
      await this.assertTag(tx, opts.tag_id);
      const now = new Date();
      const row = await this.repo.update(tx, id, { status: 'running', startedAt: now, legalBasisAt: input.legal_basis === true ? now : null });
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'started', newValue: { file_name: imp.fileName, total_rows: imp.totalRows, consent: opts.consent, duplicates: opts.duplicates, legal_basis: input.legal_basis === true, by: userId }, source: 'manual' });
      return this.view(row, await this.repo.statusCounts(tx, id));
    });
  }

  /** Procesa el siguiente lote (hasta 200 filas). Repetir la llamada continúa donde quedó; al terminar la importación queda en «done». */
  async process(id: string): Promise<ImportView> {
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id, true);
      if (imp.status === 'done') return this.view(imp, await this.repo.statusCounts(tx, id));
      if (imp.status !== 'running') throw new ConflictError('IMPORT_NOT_RUNNING', 'Esta importación no está en marcha');
      const opts = optionsOf(imp);
      const { types, validate } = await this.rules(tx);
      const batch = await this.repo.pending(tx, id, IMPORT_BATCH);
      const existing = await this.repo.contactsByPhones(tx, [...new Set(batch.flatMap((r) => this.plan(r.data ?? [], imp, opts, types, validate).phones))]);
      const tally = { created: 0, updated: 0, skipped: 0, rejected: 0 };
      for (const r of batch) {
        const plan = this.plan(r.data ?? [], imp, opts, types, validate);
        const res = await this.applyRow(tx, imp, opts, plan, existing);
        tally[res.status] += 1;
        await this.repo.setRow(tx, id, r.rowNo, res);
      }
      const counts = await this.repo.statusCounts(tx, id);
      const done = (counts['pending'] ?? 0) === 0;
      const row = await this.repo.update(tx, id, {
        createdCount: imp.createdCount + tally.created,
        updatedCount: imp.updatedCount + tally.updated,
        skippedCount: imp.skippedCount + tally.skipped,
        rejectedCount: imp.rejectedCount + tally.rejected,
        ...(done ? { status: 'done', finishedAt: new Date() } : {}),
      });
      if (done) {
        await this.repo.clearImported(tx, id);
        await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'finished', newValue: { created: row.createdCount, updated: row.updatedCount, skipped: row.skippedCount, rejected: row.rejectedCount }, source: 'manual' });
      }
      return this.view(row, counts);
    });
  }

  async cancel(id: string): Promise<ImportView> {
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id, true);
      if (imp.status === 'cancelled') return this.view(imp, await this.repo.statusCounts(tx, id));
      if (imp.status !== 'staging' && imp.status !== 'ready') throw new ConflictError('IMPORT_LOCKED', 'Una importación en marcha o terminada no se cancela');
      const row = await this.repo.update(tx, id, { status: 'cancelled' });
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'cancelled', newValue: true, source: 'manual' });
      return this.view(row, await this.repo.statusCounts(tx, id));
    });
  }

  /** CSV con las filas rechazadas y omitidas tal como venían, más el estado y el motivo. */
  async report(id: string): Promise<{ filename: string; csv: string }> {
    return this.db.withTenant(async (tx) => {
      const imp = await this.mustGet(tx, id);
      const rows = await this.repo.report(tx, id);
      const lines: unknown[][] = [[...imp.headers, 'Estado', 'Motivo'], ...rows.map((r) => [...(r.data ?? []), STATUS_LABEL[r.status] ?? r.status, r.reason ?? ''])];
      const base = imp.fileName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'importacion';
      return { filename: `${base}-reporte.csv`, csv: csvFile(lines) };
    });
  }

  // ── una fila ─────────────────────────────────────────────────────────────

  private async applyRow(
    tx: TenantTx,
    imp: ImportRow,
    opts: ImportOptions,
    plan: RowPlan,
    existing: Map<string, string>,
  ): Promise<{ status: 'created' | 'updated' | 'skipped' | 'rejected'; reason?: string; contactId?: string }> {
    if (plan.errors.length > 0) return { status: 'rejected', reason: plan.errors.join('; ').slice(0, 300) };
    const owners = [...new Set(plan.phones.map((p) => existing.get(p)).filter((x): x is string => x !== undefined))];
    if (owners.length > 1) return { status: 'skipped', reason: 'Sus teléfonos pertenecen a contactos distintos' };
    const userId = this.userId();

    if (owners.length === 1) {
      const id = owners[0]!;
      if (opts.duplicates === 'skip') return { status: 'skipped', reason: 'Ya existe un contacto con ese teléfono', contactId: id };
      const filled = await this.fillEmpty(tx, imp, opts, id, plan, existing);
      return filled.length > 0 ? { status: 'updated', contactId: id } : { status: 'skipped', reason: 'El contacto ya tenía esos datos', contactId: id };
    }

    const now = new Date();
    const [c] = await tx
      .insert(contacts)
      .values({ name: plan.name ?? plan.phones[0]!, email: plan.email, ownerId: opts.owner_id, source: 'import', consent: opts.consent, consentUpdatedAt: opts.consent === 'unknown' ? null : now, createdBy: userId })
      .returning();
    await tx.insert(contactPhones).values(plan.phones.map((e164, i) => ({ contactId: c!.id, e164, isPrimary: i === 0 })));
    if (Object.keys(plan.cf).length > 0) await this.custom.apply(tx, 'contact', c!.id, plan.cf, { creating: false });
    if (opts.tag_id) await this.tagging.addCustom(tx, c!.id, [opts.tag_id]);
    for (const p of plan.phones) existing.set(p, c!.id);
    await writeAudit(tx, { entityType: 'contact', entityId: c!.id, newValue: { name: c!.name, email: c!.email, owner_id: c!.ownerId, consent: c!.consent, phones: plan.phones, source: 'import', import_id: imp.id }, source: 'manual' });
    return { status: 'created', contactId: c!.id };
  }

  /** «Actualizar solo los campos vacíos»: completa lo que falta, nunca pisa un dato ni toca el consentimiento. Devuelve qué completó. */
  private async fillEmpty(tx: TenantTx, imp: ImportRow, opts: ImportOptions, id: string, plan: RowPlan, existing: Map<string, string>): Promise<string[]> {
    const row = await this.contactsRepo.lockById(tx, id);
    if (!row) return [];
    const filled: string[] = [];
    const set: Partial<typeof contacts.$inferInsert> = {};
    const phones = (await this.contactsRepo.phonesOf(tx, [id])).get(id) ?? [];
    if (!row.email && plan.email) {
      set.email = plan.email;
      filled.push('email');
    }
    if (plan.name && phones.some((p) => p.e164 === row.name)) {
      set.name = plan.name; // el nombre era el teléfono provisional
      filled.push('name');
    }
    if (!row.ownerId && opts.owner_id) {
      set.ownerId = opts.owner_id;
      filled.push('owner');
    }
    const room = MAX_ROW_PHONES - phones.length;
    const fresh = plan.phones.filter((p) => !existing.has(p)).slice(0, Math.max(0, room));
    if (fresh.length > 0) {
      await tx.insert(contactPhones).values(fresh.map((e164) => ({ contactId: id, e164, isPrimary: false })));
      for (const p of fresh) existing.set(p, id);
      filled.push('phones');
    }
    const current = (await this.custom.valuesFor(tx, 'contact', [id])).get(id) ?? {};
    const toFill = Object.fromEntries(Object.entries(plan.cf).filter(([k]) => current[k] === undefined));
    if (Object.keys(toFill).length > 0) {
      const changes = await this.custom.apply(tx, 'contact', id, toFill, { creating: false });
      for (const c of changes) filled.push(`custom.${c.key}`);
    }
    if (opts.tag_id && (await this.tagging.addCustom(tx, id, [opts.tag_id])) > 0) filled.push('tags');
    if (filled.length > 0) {
      await tx.update(contacts).set({ ...set, updatedAt: new Date() }).where(eq(contacts.id, id));
      await writeAudit(tx, { entityType: 'contact', entityId: id, field: 'import', newValue: { import_id: imp.id, filled }, source: 'manual' });
    }
    return filled;
  }

  // ── ayudas ───────────────────────────────────────────────────────────────

  private async rules(tx: TenantTx) {
    const labels = await this.custom.labels(tx, 'contact');
    return { types: new Map<string, FieldType>(labels.map((f) => [f.key, f.type])), validate: await this.custom.validator(tx, 'contact') };
  }

  /** Fila → plan, sumando los errores de los campos personalizados. */
  private plan(cells: readonly string[], imp: ImportRow, opts: ImportOptions, types: ReadonlyMap<string, FieldType>, validate: Awaited<ReturnType<ContactImportsService['rules']>>['validate']): RowPlan {
    const p = planRow(cells, imp.mapping, opts.country_prefix, types);
    if (p.errors.length === 0 && Object.keys(p.cf).length > 0) for (const e of validate(p.cf)) p.errors.push(e.message);
    return p;
  }

  private async mustGet(tx: TenantTx, id: string, lock = false): Promise<ImportRow> {
    const row = await this.repo.byId(tx, id, lock);
    if (!row) throw new NotFoundError();
    return row;
  }

  private view(r: ImportRow, counts: Record<string, number>): ImportView {
    const pending = counts['pending'] ?? 0;
    const staged = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      id: r.id,
      file_name: r.fileName,
      status: r.status,
      total_rows: r.totalRows,
      staged_rows: staged,
      headers: r.headers,
      mapping: r.mapping,
      options: optionsOf(r),
      counts: { created: r.createdCount, updated: r.updatedCount, skipped: r.skippedCount, rejected: r.rejectedCount, pending },
      legal_basis_at: iso(r.legalBasisAt),
      created_at: r.createdAt.toISOString(),
      started_at: iso(r.startedAt),
      finished_at: iso(r.finishedAt),
    };
  }

  private duplicateFile(prev: ImportRow): AppError {
    return new AppError(409, 'IMPORT_DUPLICATE_FILE', `Este archivo ya se importó (importación «${prev.fileName}»)`, [{ path: 'import_id', code: 'duplicate', message: prev.id }]);
  }

  private userId(): string {
    const u = TenantContext.current().userId;
    if (!u) throw new NotFoundError();
    return u;
  }

  private async assertOwner(ownerId: string | null): Promise<void> {
    if (ownerId && !(await this.members.canBeAssigned(ownerId))) throw new ValidationError([{ path: 'options.owner_id', code: 'invalid_owner', message: 'Esa persona no puede recibir contactos' }]);
  }

  private async assertTag(tx: TenantTx, tagId: string | null): Promise<void> {
    if (tagId && !(await this.tagging.allCustom(tx, [tagId]))) throw new ValidationError([{ path: 'options.tag_id', code: 'invalid_tag', message: 'La etiqueta no existe o es del sistema' }]);
  }
}
