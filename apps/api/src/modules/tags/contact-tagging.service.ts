import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { contactTags, tags, type TenantTx } from '../../db';
import { ValidationError } from '../../errors';
import { TagChangeBus, type TagChangeOrigin } from './tag-change.bus';

/**
 * Etiquetas personalizadas de un contacto (M3.4, ADR-46). `setCustom` deja EXACTAMENTE ese conjunto de etiquetas personalizadas; las del sistema no se
 * tocan nunca. Corre dentro de la transacción del que llama (que ya comprobó que el contacto es visible para la persona). Cada cambio se anuncia en el
 * `TagChangeBus` (M7.3) con su origen, para que un canal externo (GoHighLevel) lo refleje sin devolver el eco de lo que ya viene de él.
 */
@Injectable()
export class ContactTaggingService {
  constructor(@Inject(TagChangeBus) private readonly bus: TagChangeBus) {}

  /** AGREGA etiquetas personalizadas a un contacto sin quitar ninguna (importaciones). Devuelve cuántas puso de verdad. Los ids ya se validaron al configurar la importación. */
  async addCustom(tx: TenantTx, contactId: string, tagIds: readonly string[]): Promise<number> {
    if (tagIds.length === 0) return 0;
    const rows = await tx.insert(contactTags).values(tagIds.map((tagId) => ({ contactId, tagId, setBy: 'user' }))).onConflictDoNothing().returning({ tagId: contactTags.tagId });
    if (rows.length > 0 && this.bus.size > 0) await this.announce(tx, contactId, rows.map((r) => r.tagId), 'add', 'local');
    return rows.length;
  }

  /** ¿Son todas etiquetas personalizadas vigentes de esta empresa? */
  async allCustom(tx: TenantTx, tagIds: readonly string[]): Promise<boolean> {
    if (tagIds.length === 0) return true;
    const rows = await tx.select({ id: tags.id }).from(tags).where(and(inArray(tags.id, [...tagIds]), eq(tags.isSystem, false), isNull(tags.deletedAt)));
    return rows.length === new Set(tagIds).size;
  }

  /** Devuelve los nombres antes y después, o null si no cambió nada. */
  async setCustom(tx: TenantTx, contactId: string, tagIds: readonly string[]): Promise<{ before: string[]; after: string[] } | null> {
    const wanted = tagIds.length === 0 ? [] : await tx.select().from(tags).where(and(inArray(tags.id, [...tagIds]), isNull(tags.deletedAt)));
    const bad = tagIds.filter((id) => !wanted.some((t) => t.id === id && !t.isSystem));
    if (bad.length > 0) throw new ValidationError(bad.map((id) => ({ path: 'tag_ids', code: 'invalid_tag', message: `La etiqueta ${id} no existe o es del sistema` })));

    const current = await tx
      .select({ id: tags.id, name: tags.name })
      .from(contactTags)
      .innerJoin(tags, and(eq(tags.organizationId, contactTags.organizationId), eq(tags.id, contactTags.tagId)))
      .where(and(eq(contactTags.contactId, contactId), eq(tags.isSystem, false), isNull(tags.deletedAt)));
    const have = new Set(current.map((t) => t.id));
    const want = new Set(wanted.map((t) => t.id));
    const toAdd = wanted.filter((t) => !have.has(t.id));
    const toRemove = current.filter((t) => !want.has(t.id));
    if (toAdd.length === 0 && toRemove.length === 0) return null;
    if (toAdd.length > 0) await tx.insert(contactTags).values(toAdd.map((t) => ({ contactId, tagId: t.id, setBy: 'user' }))).onConflictDoNothing();
    if (toRemove.length > 0) await tx.delete(contactTags).where(and(eq(contactTags.contactId, contactId), inArray(contactTags.tagId, toRemove.map((t) => t.id))));
    for (const t of toAdd) await this.bus.emit(tx, { contactId, tagName: t.name, tagKind: 'custom', op: 'add', origin: 'local' });
    for (const t of toRemove) await this.bus.emit(tx, { contactId, tagName: t.name, tagKind: 'custom', op: 'remove', origin: 'local' });
    const names = (rows: ReadonlyArray<{ name: string }>) => rows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
    return { before: names(current), after: names(wanted) };
  }

  /**
   * Aplica a un contacto un cambio de etiquetas personalizadas que YA ocurrió en otro lugar (GoHighLevel, M7.3): agrega y quita solo lo que de verdad falta o sobra y lo anuncia con su
   * origen, para que no se devuelva. Los ids ya se validaron como personalizadas vigentes. Devuelve los nombres realmente agregados y quitados.
   */
  async applyExternal(tx: TenantTx, contactId: string, change: { add: readonly string[]; remove: readonly string[] }, origin: TagChangeOrigin): Promise<{ added: string[]; removed: string[] }> {
    const added: string[] = [];
    const removed: string[] = [];
    if (change.add.length > 0) {
      const rows = await tx.insert(contactTags).values(change.add.map((tagId) => ({ contactId, tagId, setBy: 'user' }))).onConflictDoNothing().returning({ tagId: contactTags.tagId });
      for (const n of await this.namesOf(tx, rows.map((r) => r.tagId))) added.push(n);
    }
    if (change.remove.length > 0) {
      const rows = await tx.delete(contactTags).where(and(eq(contactTags.contactId, contactId), inArray(contactTags.tagId, [...change.remove]))).returning({ tagId: contactTags.tagId });
      for (const n of await this.namesOf(tx, rows.map((r) => r.tagId))) removed.push(n);
    }
    for (const tagName of added) await this.bus.emit(tx, { contactId, tagName, tagKind: 'custom', op: 'add', origin });
    for (const tagName of removed) await this.bus.emit(tx, { contactId, tagName, tagKind: 'custom', op: 'remove', origin });
    return { added, removed };
  }

  private async namesOf(tx: TenantTx, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    return (await tx.select({ name: tags.name }).from(tags).where(inArray(tags.id, [...ids]))).map((r) => r.name);
  }

  private async announce(tx: TenantTx, contactId: string, tagIds: readonly string[], op: 'add' | 'remove', origin: TagChangeOrigin): Promise<void> {
    for (const tagName of await this.namesOf(tx, tagIds)) await this.bus.emit(tx, { contactId, tagName, tagKind: 'custom', op, origin });
  }
}
