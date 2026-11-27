import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { contactTags, Database, tags, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import { TagChangeBus } from './tag-change.bus';

export type SystemTagKey = 'lead' | 'appointment' | 'sale';

/** Las tres etiquetas del sistema (ADR-08/45). Nombres y colores fijos: no se pueden renombrar ni borrar. */
export const SYSTEM_TAGS: Readonly<Record<SystemTagKey, { name: string; color: string }>> = {
  lead: { name: 'Lead', color: '#2563eb' },
  appointment: { name: 'Cita agendada', color: '#16a34a' },
  sale: { name: 'Venta', color: '#d97706' },
};
const KEYS = Object.keys(SYSTEM_TAGS) as SystemTagKey[];

export interface TagView {
  id: string;
  name: string;
  color: string;
  /** null en las etiquetas personalizadas (M3.4). */
  system_key: SystemTagKey | null;
  is_system: boolean;
}

type TagRow = typeof tags.$inferSelect;
export const toTagView = (r: TagRow): TagView => ({ id: r.id, name: r.name, color: r.color, system_key: (r.systemKey as SystemTagKey | null) ?? null, is_system: r.isSystem });

/**
 * Etiquetas del SISTEMA (M3.3, ADR-45): `Lead`, `Cita agendada` y `Venta`. Nadie las edita ni las borra. `Cita agendada` y `Venta` solo las pone el sistema (citas, ventas); `Lead` la coloca
 * o quita una persona (`setLeadByUser`) y los formularios web la ponen solos. Cada empresa recibe las suyas al primer uso (idempotente). Trabaja DENTRO de la transacción del que llama.
 */
@Injectable()
export class SystemTagsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TagChangeBus) private readonly bus: TagChangeBus,
  ) {}

  /** Asegura las tres etiquetas de la empresa activa y devuelve su id por clave. */
  async ensure(tx: TenantTx): Promise<Map<SystemTagKey, string>> {
    const read = () => tx.select().from(tags).where(and(eq(tags.isSystem, true), isNull(tags.deletedAt)));
    let rows = await read();
    if (KEYS.some((k) => !rows.some((r) => r.systemKey === k))) {
      await tx
        .insert(tags)
        .values(KEYS.map((k) => ({ name: SYSTEM_TAGS[k].name, color: SYSTEM_TAGS[k].color, isSystem: true, systemKey: k })))
        .onConflictDoNothing(); // dos primeros usos a la vez: gana uno y el otro encuentra las filas
      rows = await read();
    }
    return new Map(rows.map((r) => [r.systemKey as SystemTagKey, r.id]));
  }

  /** Pone la etiqueta del sistema a un contacto (idempotente). Devuelve true solo si la puso ahora. */
  async apply(tx: TenantTx, contactId: string, key: SystemTagKey): Promise<boolean> {
    const tagId = (await this.ensure(tx)).get(key)!;
    const inserted = await tx.insert(contactTags).values({ contactId, tagId, setBy: 'system' }).onConflictDoNothing().returning({ tagId: contactTags.tagId });
    if (inserted.length === 0) return false;
    await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: 'tag', oldValue: null, newValue: key, source: 'automation' });
    await this.bus.emit(tx, { contactId, tagName: SYSTEM_TAGS[key].name, tagKind: 'system', op: 'add', origin: 'local' });
    return true;
  }

  /**
   * Una PERSONA coloca o quita la etiqueta `Lead` de un contacto: es la única etiqueta del sistema que se maneja a mano (decisión del responsable, 2026-11-23: el Lead hacia Meta sale cuando el
   * asesor la coloca; el sistema ya no la pone al llegar un mensaje). Quien llama comprobó que el contacto es visible para la persona. Devuelve true solo si algo cambió.
   */
  async setLeadByUser(tx: TenantTx, contactId: string, on: boolean): Promise<boolean> {
    const tagId = (await this.ensure(tx)).get('lead')!;
    if (on) {
      const inserted = await tx.insert(contactTags).values({ contactId, tagId, setBy: 'user' }).onConflictDoNothing().returning({ tagId: contactTags.tagId });
      if (inserted.length === 0) return false;
    } else {
      const removed = await tx.delete(contactTags).where(and(eq(contactTags.contactId, contactId), eq(contactTags.tagId, tagId))).returning({ tagId: contactTags.tagId });
      if (removed.length === 0) return false;
    }
    await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: 'tag', oldValue: on ? null : 'lead', newValue: on ? 'lead' : null, source: 'manual' });
    await this.bus.emit(tx, { contactId, tagName: SYSTEM_TAGS.lead.name, tagKind: 'system', op: on ? 'add' : 'remove', origin: 'local' });
    return true;
  }

  /** Etiquetas de varios contactos (las del sistema primero). */
  async forContacts(tx: TenantTx, ids: readonly string[]): Promise<Map<string, TagView[]>> {
    const out = new Map<string, TagView[]>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ contactId: contactTags.contactId, tag: tags })
      .from(contactTags)
      .innerJoin(tags, and(eq(tags.organizationId, contactTags.organizationId), eq(tags.id, contactTags.tagId)))
      .where(and(inArray(contactTags.contactId, [...ids]), isNull(tags.deletedAt)))
      .orderBy(asc(tags.name));
    for (const r of rows) out.set(r.contactId, [...(out.get(r.contactId) ?? []), toTagView(r.tag)]);
    return out;
  }

  /** Etiquetas vigentes de la empresa (asegura las del sistema antes de listar). */
  async list(): Promise<{ items: TagView[] }> {
    return this.db.withTenant(async (tx) => {
      await this.ensure(tx);
      const rows = await tx.select().from(tags).where(isNull(tags.deletedAt)).orderBy(asc(tags.name));
      return { items: rows.map(toTagView) };
    });
  }
}
