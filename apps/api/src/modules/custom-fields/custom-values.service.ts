import { Inject, Injectable } from '@nestjs/common';
import type { TenantTx } from '../../db';
import { ValidationError, type ErrorDetail } from '../../errors';
import { TenantContext } from '../../tenant';
import { CustomFieldsRepository, type DefinitionRow } from './custom-fields.repository';
import { coerceValue, display, fromColumns, toColumns, type CustomEntity, type CustomValue, type CustomValues, type FieldType, type Normalized } from './field-types';

/** Un cambio real de un valor (para la auditoría del que lo llama). */
export interface CustomChange {
  key: string;
  oldValue: CustomValue | null;
  newValue: CustomValue | null;
}

/** Un campo del contacto tal como se le describe a la IA (M8.5b). */
export interface AiFieldDef {
  key: string;
  name: string;
  type: FieldType;
  options: string[] | null;
}

/** Lo que pasó al escribir los campos que pidió la IA: lo escrito, lo que ya estaba igual y lo que se rechazó (con el motivo, que se le devuelve al modelo). */
export interface AiFieldOutcome {
  changes: CustomChange[];
  unchanged: string[];
  rejected: Array<{ key: string; reason: string }>;
}

const path = (key: string): string => `custom_fields.${key}`;

/**
 * Valores de campos personalizados de una entidad (M3.2, ADR-44). Lo usan los módulos que tienen la entidad (hoy `contacts`) DENTRO de su propia
 * transacción: leen los valores de varias entidades a la vez y aplican los cambios de una con validación completa. No abre transacciones.
 */
@Injectable()
export class CustomValuesService {
  constructor(@Inject(CustomFieldsRepository) private readonly repo: CustomFieldsRepository) {}

  /** Campos activos de una entidad por variable (para resolver filtros por campo personalizado). */
  async definitionsByKey(tx: TenantTx, entity: CustomEntity): Promise<Map<string, { id: string; type: string }>> {
    return new Map((await this.repo.list(tx, entity, false)).map((d) => [d.varKey, { id: d.id, type: d.type }]));
  }

  /** Nombre y tipo de los campos activos (para rotular columnas y convertir valores de un archivo). */
  async labels(tx: TenantTx, entity: CustomEntity): Promise<Array<{ key: string; name: string; type: FieldType }>> {
    return (await this.repo.list(tx, entity, false)).map((d) => ({ key: d.varKey, name: d.name, type: d.type as FieldType }));
  }

  /**
   * Un validador de valores con las definiciones cargadas UNA vez (importaciones: miles de filas, una sola lectura). Valida SIN escribir; los obligatorios no
   * se exigen aquí. Devuelve los errores de una fila (vacío = válida).
   */
  async validator(tx: TenantTx, entity: CustomEntity): Promise<(input: Readonly<Record<string, unknown>>) => ErrorDetail[]> {
    const byKey = new Map((await this.repo.list(tx, entity, false)).map((d) => [d.varKey, d]));
    return (input) => {
      const errors: ErrorDetail[] = [];
      for (const [key, raw] of Object.entries(input)) {
        const def = byKey.get(key);
        if (!def) errors.push({ path: path(key), code: 'unknown_field', message: 'Ese campo no existe o está archivado' });
        else {
          const r = coerceValue(def.type as FieldType, def.options, raw);
          if (!r.ok) errors.push({ path: path(key), code: r.code, message: `${def.name}: ${r.message}` });
        }
      }
      return errors;
    };
  }

  /** Valores NO vacíos de campos NO archivados, por id de entidad y por variable. */
  async valuesFor(tx: TenantTx, entity: CustomEntity, ids: readonly string[]): Promise<Map<string, CustomValues>> {
    const out = new Map<string, CustomValues>();
    if (ids.length === 0) return out;
    const defs = await this.repo.list(tx, entity, false);
    if (defs.length === 0) return out;
    const byId = new Map(defs.map((d) => [d.id, d]));
    for (const row of await this.repo.valuesOf(tx, entity, ids, defs.map((d) => d.id))) {
      const def = byId.get(row.definitionId);
      if (!def) continue;
      const v = fromColumns(def.type as FieldType, row);
      if (v === null) continue;
      out.set(row.entityId, { ...(out.get(row.entityId) ?? {}), [def.varKey]: v });
    }
    return out;
  }

  /**
   * Llena en un contacto los campos personalizados que mandó un formulario (M9.1, ADR-09/54): **solo los que están vacíos**; lo que el contacto ya tiene, lo haya escrito quien lo haya escrito, no se
   * cambia. Cada campo se decide por separado y no falla por completo: el campo debe existir y estar activo, y el valor ser válido para su tipo. Escribe sin usuario (`updated_by` nulo).
   */
  async fillEmpty(tx: TenantTx, contactId: string, input: Readonly<Record<string, unknown>>): Promise<AiFieldOutcome> {
    const defs = new Map((await this.repo.list(tx, 'contact', false)).map((d) => [d.varKey, d]));
    const out: AiFieldOutcome = { changes: [], unchanged: [], rejected: [] };
    const prepared: Array<{ def: DefinitionRow; norm: Normalized }> = [];
    for (const [key, raw] of Object.entries(input)) {
      const def = defs.get(key);
      if (!def) {
        out.rejected.push({ key, reason: 'ese campo no existe o está archivado' });
        continue;
      }
      const r = coerceValue(def.type as FieldType, def.options, raw);
      if (!r.ok) out.rejected.push({ key, reason: r.message });
      else if (r.value !== null) prepared.push({ def, norm: r.value });
    }
    if (prepared.length === 0) return out;
    const existing = new Map((await this.repo.valuesOf(tx, 'contact', [contactId], prepared.map((p) => p.def.id))).map((r) => [r.definitionId, r]));
    for (const { def, norm } of prepared) {
      const row = existing.get(def.id);
      const oldValue = row ? fromColumns(def.type as FieldType, row) : null;
      if (oldValue !== null) {
        out.unchanged.push(def.varKey);
        continue;
      }
      await this.repo.upsertValue(tx, { entity: 'contact', entityId: contactId, definitionId: def.id }, toColumns(norm), null);
      out.changes.push({ key: def.varKey, oldValue: null, newValue: display(norm) });
    }
    return out;
  }

  /** Los campos ACTIVOS de los contactos con esas variables, en el orden pedido (los archivados o inexistentes no aparecen). */
  async contactFields(tx: TenantTx, keys: readonly string[]): Promise<AiFieldDef[]> {
    const byKey = new Map((await this.repo.list(tx, 'contact', false)).map((d) => [d.varKey, d]));
    return keys.flatMap((k) => {
      const d = byKey.get(k);
      return d ? [{ key: d.varKey, name: d.name, type: d.type as FieldType, options: d.options ? [...d.options] : null }] : [];
    });
  }

  /**
   * Escribe en un contacto los campos que pidió la IA (M8.5b, ADR-53; F17). A diferencia de `apply` NO falla por completo: cada campo se decide por separado y el motivo de lo rechazado vuelve al modelo.
   * Reglas: el campo debe existir y estar activo; el valor debe ser válido para su tipo; **no se puede vaciar**; y **no pisa lo que escribió una persona** (si el último en escribirlo fue un usuario y el valor es
   * distinto, se rechaza). Lo que la IA escribió antes sí puede corregirlo. Escribe sin usuario (`updated_by` nulo = automatización).
   */
  async applyForAi(tx: TenantTx, contactId: string, input: Readonly<Record<string, unknown>>): Promise<AiFieldOutcome> {
    const defs = new Map((await this.repo.list(tx, 'contact', false)).map((d) => [d.varKey, d]));
    const out: AiFieldOutcome = { changes: [], unchanged: [], rejected: [] };
    const prepared: Array<{ def: DefinitionRow; norm: Normalized }> = [];
    for (const [key, raw] of Object.entries(input)) {
      const def = defs.get(key);
      if (!def) {
        out.rejected.push({ key, reason: 'ese campo no existe o está archivado' });
        continue;
      }
      const r = coerceValue(def.type as FieldType, def.options, raw);
      if (!r.ok) out.rejected.push({ key, reason: r.message });
      else if (r.value === null) out.rejected.push({ key, reason: 'no se puede dejar vacío' });
      else prepared.push({ def, norm: r.value });
    }
    if (prepared.length === 0) return out;
    const existing = new Map((await this.repo.valuesOf(tx, 'contact', [contactId], prepared.map((p) => p.def.id))).map((r) => [r.definitionId, r]));
    for (const { def, norm } of prepared) {
      const row = existing.get(def.id);
      const oldValue = row ? fromColumns(def.type as FieldType, row) : null;
      const newValue = display(norm);
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
        out.unchanged.push(def.varKey);
        continue;
      }
      if (row && row.updatedBy !== null) {
        out.rejected.push({ key: def.varKey, reason: 'ya tiene un valor que escribió una persona y no se cambia' });
        continue;
      }
      await this.repo.upsertValue(tx, { entity: 'contact', entityId: contactId, definitionId: def.id }, toColumns(norm), null);
      out.changes.push({ key: def.varKey, oldValue, newValue });
    }
    return out;
  }

  /**
   * Aplica `input` (`{ variable: valor }`) a una entidad. Valida TODO antes de escribir (si algo falla no se toca nada y se informan todos los errores).
   *  - Variable desconocida o de un campo archivado → error.
   *  - `creating`: los campos obligatorios deben traer valor. En una edición no se puede VACIAR un obligatorio, pero editar otra cosa de un registro
   *    antiguo que no lo tiene no falla (ADR-44 #5).
   * Devuelve solo los cambios reales (un valor igual al guardado no escribe ni audita).
   */
  async apply(tx: TenantTx, entity: CustomEntity, entityId: string, input: Readonly<Record<string, unknown>>, mode: { creating: boolean }): Promise<CustomChange[]> {
    const defs = await this.repo.list(tx, entity, false);
    const byKey = new Map(defs.map((d) => [d.varKey, d]));
    const errors: ErrorDetail[] = [];
    const prepared: Array<{ def: DefinitionRow; norm: Normalized | null }> = [];

    for (const [key, raw] of Object.entries(input)) {
      const def = byKey.get(key);
      if (!def) {
        errors.push({ path: path(key), code: 'unknown_field', message: 'Ese campo no existe o está archivado' });
        continue;
      }
      const r = coerceValue(def.type as FieldType, def.options, raw);
      if (!r.ok) errors.push({ path: path(key), code: r.code, message: r.message });
      else prepared.push({ def, norm: r.value });
    }

    if (mode.creating) {
      const given = new Set(prepared.filter((p) => p.norm !== null).map((p) => p.def.id));
      for (const d of defs) if (d.required && !given.has(d.id)) errors.push({ path: path(d.varKey), code: 'required', message: `«${d.name}» es obligatorio` });
    } else {
      for (const p of prepared) if (p.norm === null && p.def.required) errors.push({ path: path(p.def.varKey), code: 'required', message: `«${p.def.name}» es obligatorio: no se puede dejar vacío` });
    }
    if (errors.length > 0) throw new ValidationError(errors);
    if (prepared.length === 0) return [];

    const existing = new Map((await this.repo.valuesOf(tx, entity, [entityId], prepared.map((p) => p.def.id))).map((r) => [r.definitionId, r]));
    const userId = TenantContext.current().userId ?? null;
    const changes: CustomChange[] = [];
    for (const { def, norm } of prepared) {
      const row = existing.get(def.id);
      const oldValue = row ? fromColumns(def.type as FieldType, row) : null;
      const newValue = display(norm);
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      await this.repo.upsertValue(tx, { entity, entityId, definitionId: def.id }, toColumns(norm), userId);
      changes.push({ key: def.varKey, oldValue, newValue });
    }
    return changes;
  }
}
