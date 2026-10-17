import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { contactTags, tags, type TenantTx } from '../../db';
import { ValidationError } from '../../errors';

/**
 * Etiquetas personalizadas de un contacto (M3.4, ADR-46). `setCustom` deja EXACTAMENTE ese conjunto de etiquetas personalizadas; las del sistema no se
 * tocan nunca. Corre dentro de la transacción del que llama (que ya comprobó que el contacto es visible para la persona).
 */
@Injectable()
export class ContactTaggingService {
  /** AGREGA etiquetas personalizadas a un contacto sin quitar ninguna (importaciones). Devuelve cuántas puso de verdad. Los ids ya se validaron al configurar la importación. */
  async addCustom(tx: TenantTx, contactId: string, tagIds: readonly string[]): Promise<number> {
    if (tagIds.length === 0) return 0;
    const rows = await tx.insert(contactTags).values(tagIds.map((tagId) => ({ contactId, tagId, setBy: 'user' }))).onConflictDoNothing().returning({ tagId: contactTags.tagId });
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
    const names = (rows: ReadonlyArray<{ name: string }>) => rows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
    return { before: names(current), after: names(wanted) };
  }
}
