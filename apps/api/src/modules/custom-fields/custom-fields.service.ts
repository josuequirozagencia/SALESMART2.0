import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import type { CreateFieldDto, ListFieldsQuery, OrderFieldsDto, UpdateFieldDto } from './custom-fields.dto';
import { CustomFieldsRepository, type DefinitionRow } from './custom-fields.repository';
import { cleanOptions, isOptionType, MAX_FIELDS_PER_ENTITY, RESERVED_KEYS, slugifyKey, type FieldType } from './field-types';

export interface FieldView {
  id: string;
  entity: string;
  name: string;
  /** Variable de plantillas y automatizaciones: `{{contact.<key>}}`. No cambia nunca. */
  key: string;
  type: FieldType;
  options: string[] | null;
  required: boolean;
  show_in_form: boolean;
  position: number;
  archived_at: string | null;
  created_at: string;
}

const iso = (d: Date): string => d.toISOString();
const view = (r: DefinitionRow): FieldView => ({
  id: r.id,
  entity: r.entity,
  name: r.name,
  key: r.varKey,
  type: r.type as FieldType,
  options: r.options ?? null,
  required: r.required,
  show_in_form: r.showInForm,
  position: r.position,
  archived_at: r.archivedAt ? iso(r.archivedAt) : null,
  created_at: iso(r.createdAt),
});

const AUDIT = 'custom_field';
const invalid = (path: string, code: string, message: string) => new ValidationError([{ path, code, message }]);

/**
 * Definiciones de campos personalizados (M3.2, ADR-44). Tenant: la organización sale del contexto verificado y la aísla la RLS.
 * Los campos NO se borran: se archivan (su variable queda reservada). El tipo y la variable no cambian. Cada cambio queda en la auditoría del cliente
 * en la misma transacción.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CustomFieldsRepository) private readonly repo: CustomFieldsRepository,
  ) {}

  async list(q: ListFieldsQuery): Promise<{ items: FieldView[] }> {
    const rows = await this.db.withTenant((tx) => this.repo.list(tx, q.entity, q.archived === 'include'));
    return { items: rows.map(view) };
  }

  async create(input: CreateFieldDto): Promise<FieldView> {
    const options = this.optionsFor(input.type, input.options);
    if (input.required && !input.show_in_form) throw invalid('required', 'requires_form', 'Un campo obligatorio debe mostrarse en el formulario');
    const key = slugifyKey(input.name);
    if (RESERVED_KEYS.has(key)) throw new ConflictError('CUSTOM_FIELD_KEY_RESERVED', `«${key}» está reservado para un dato estándar del contacto. Usa otro nombre para el campo`);

    const row = await this.db
      .withTenant(async (tx) => {
        await this.repo.lockEntity(tx, input.entity);
        const taken = await this.repo.byKey(tx, input.entity, key);
        if (taken) throw this.keyTaken(taken);
        if ((await this.repo.countActive(tx, input.entity)) >= MAX_FIELDS_PER_ENTITY) throw this.limit();
        const created = await this.repo.insert(tx, {
          entity: input.entity,
          name: input.name,
          varKey: key,
          type: input.type,
          options,
          required: input.required,
          showInForm: input.show_in_form,
          position: await this.repo.nextPosition(tx, input.entity),
          createdBy: TenantContext.current().userId ?? null,
        });
        await writeAudit(tx, { entityType: AUDIT, entityId: created.id, newValue: { name: created.name, key, type: created.type, options, required: created.required, show_in_form: created.showInForm }, source: 'manual' });
        return created;
      })
      .catch((e: unknown) => {
        throw this.keyRace(e) ?? e;
      });
    return view(row);
  }

  async update(id: string, input: UpdateFieldDto): Promise<FieldView> {
    const row = await this.db.withTenant(async (tx) => {
      const cur = await this.repo.byId(tx, id, true);
      if (!cur) throw new NotFoundError();
      if (cur.archivedAt) throw this.archived();

      const set: Partial<typeof cur> = {};
      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
      if (input.name !== undefined && input.name !== cur.name) {
        set.name = input.name;
        changes.push({ field: 'name', oldValue: cur.name, newValue: input.name });
      }
      if (input.options !== undefined) {
        if (!isOptionType(cur.type as FieldType)) throw invalid('options', 'not_applicable', 'Solo los campos de selección tienen opciones');
        const next = this.optionsFor(cur.type as FieldType, input.options);
        if (JSON.stringify(next) !== JSON.stringify(cur.options)) {
          set.options = next;
          changes.push({ field: 'options', oldValue: cur.options, newValue: next });
        }
      }
      const showInForm = input.show_in_form ?? cur.showInForm;
      // Ocultar un campo obligatorio lo deja de hacer obligatorio; pedir obligatorio un campo oculto es un error
      let required = input.required ?? cur.required;
      if (!showInForm) {
        if (input.required === true) throw invalid('required', 'requires_form', 'Un campo obligatorio debe mostrarse en el formulario');
        required = false;
      }
      if (showInForm !== cur.showInForm) {
        set.showInForm = showInForm;
        changes.push({ field: 'show_in_form', oldValue: cur.showInForm, newValue: showInForm });
      }
      if (required !== cur.required) {
        set.required = required;
        changes.push({ field: 'required', oldValue: cur.required, newValue: required });
      }
      if (changes.length === 0) return cur;
      const updated = await this.repo.update(tx, id, set);
      for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      return updated;
    });
    return view(row);
  }

  async archive(id: string): Promise<FieldView> {
    return this.setArchived(id, true);
  }

  async restore(id: string): Promise<FieldView> {
    return this.setArchived(id, false);
  }

  /** `ids` debe ser EXACTAMENTE el conjunto de campos activos de la entidad (si la pantalla quedó desactualizada, 409). */
  async reorder(input: OrderFieldsDto): Promise<{ items: FieldView[] }> {
    const rows = await this.db.withTenant(async (tx) => {
      await this.repo.lockEntity(tx, input.entity);
      const all = await this.repo.list(tx, input.entity, true);
      const active = all.filter((r) => !r.archivedAt);
      const same = active.length === input.ids.length && active.every((r) => input.ids.includes(r.id));
      if (!same) throw new ConflictError('CUSTOM_FIELD_ORDER_STALE', 'La lista de campos cambió. Actualiza la pantalla e inténtalo de nuevo');
      const wanted = [...input.ids, ...all.filter((r) => r.archivedAt).map((r) => r.id)];
      const byId = new Map(all.map((r) => [r.id, r]));
      for (const [pos, id] of wanted.entries()) {
        const cur = byId.get(id)!;
        if (cur.position === pos) continue;
        await this.repo.update(tx, id, { position: pos });
        await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'position', oldValue: cur.position, newValue: pos, source: 'manual' });
      }
      return this.repo.list(tx, input.entity, true);
    });
    return { items: rows.map(view) };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async setArchived(id: string, archive: boolean): Promise<FieldView> {
    const row = await this.db.withTenant(async (tx) => {
      const probe = await this.repo.byId(tx, id);
      if (!probe) throw new NotFoundError();
      await this.repo.lockEntity(tx, probe.entity); // mismo candado que el alta: el tope de campos activos no se rebasa
      const cur = await this.repo.byId(tx, id, true);
      if (!cur) throw new NotFoundError();
      if (archive === (cur.archivedAt !== null)) return cur; // ya estaba así: idempotente
      if (!archive && (await this.repo.countActive(tx, cur.entity)) >= MAX_FIELDS_PER_ENTITY) throw this.limit();
      const at = archive ? new Date() : null;
      const updated = await this.repo.update(tx, id, { archivedAt: at });
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'archived_at', oldValue: cur.archivedAt ? iso(cur.archivedAt) : null, newValue: at ? iso(at) : null, source: 'manual' });
      return updated;
    });
    return view(row);
  }

  /** Opciones válidas de un campo de selección, o ninguna si el tipo no las tiene. */
  private optionsFor(type: FieldType, raw: readonly string[] | undefined): string[] | null {
    if (!isOptionType(type)) {
      if (raw !== undefined && raw.length > 0) throw invalid('options', 'not_applicable', 'Solo los campos de selección tienen opciones');
      return null;
    }
    const clean = raw === undefined ? null : cleanOptions(raw);
    if (!clean) throw invalid('options', 'invalid', 'Escribe de 1 a 50 opciones distintas, de hasta 100 caracteres cada una');
    return clean;
  }

  private keyTaken(r: DefinitionRow): AppError {
    return new ConflictError(
      'CUSTOM_FIELD_EXISTS',
      r.archivedAt ? `Ya existe un campo archivado con esa variable («${r.name}»). Restáuralo o usa otro nombre` : `Ya existe un campo con ese nombre («${r.name}»)`,
    );
  }

  private limit(): AppError {
    return new ConflictError('CUSTOM_FIELD_LIMIT', `Se alcanzó el máximo de ${MAX_FIELDS_PER_ENTITY} campos. Archiva alguno para crear otro`);
  }

  private archived(): AppError {
    return new ConflictError('CUSTOM_FIELD_ARCHIVED', 'El campo está archivado. Restáuralo para editarlo');
  }

  /** Dos altas simultáneas del mismo nombre: el candado las serializa, pero el índice único es la última palabra. */
  private keyRace(e: unknown): AppError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    if (cause?.code === '23505' && cause.constraint === 'custom_field_definitions_org_entity_key_uq') return new ConflictError('CUSTOM_FIELD_EXISTS', 'Ya existe un campo con ese nombre');
    return undefined;
  }
}

