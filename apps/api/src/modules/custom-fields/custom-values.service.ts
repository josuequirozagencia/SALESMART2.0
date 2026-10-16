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

const path = (key: string): string => `custom_fields.${key}`;

/**
 * Valores de campos personalizados de una entidad (M3.2, ADR-44). Lo usan los módulos que tienen la entidad (hoy `contacts`) DENTRO de su propia
 * transacción: leen los valores de varias entidades a la vez y aplican los cambios de una con validación completa. No abre transacciones.
 */
@Injectable()
export class CustomValuesService {
  constructor(@Inject(CustomFieldsRepository) private readonly repo: CustomFieldsRepository) {}

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
