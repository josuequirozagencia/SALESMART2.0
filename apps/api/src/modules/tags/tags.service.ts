import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Database, tags } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { writeAudit } from '../audit';
import type { CreateTagDto, UpdateTagDto } from './tags.dto';
import { SystemTagsService, toTagView, type TagView } from './system-tags.service';
import { TagChangeBus } from './tag-change.bus';

export const MAX_CUSTOM_TAGS = 100;
const AUDIT = 'tag';

/**
 * Etiquetas PERSONALIZADAS de la empresa (M3.4, ADR-46): el administrador las crea, renombra, recolorea y borra (borrado lógico). Las del sistema no se
 * tocan nunca (409). El nombre es único sin distinguir mayúsculas entre las vigentes, también frente a los de las etiquetas del sistema.
 */
@Injectable()
export class TagsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SystemTagsService) private readonly system: SystemTagsService,
    @Inject(TagChangeBus) private readonly bus: TagChangeBus,
  ) {}

  async create(input: CreateTagDto): Promise<TagView> {
    const row = await this.db
      .withTenant(async (tx) => {
        await this.system.ensure(tx);
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(tags).where(and(eq(tags.isSystem, false), isNull(tags.deletedAt)));
        if ((n?.n ?? 0) >= MAX_CUSTOM_TAGS) throw new ConflictError('TAG_LIMIT', `Se alcanzó el máximo de ${MAX_CUSTOM_TAGS} etiquetas. Borra alguna para crear otra`);
        const [created] = await tx.insert(tags).values({ name: input.name, color: input.color }).returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: created!.id, newValue: { name: created!.name, color: created!.color }, source: 'manual' });
        return created!;
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return toTagView(row);
  }

  async update(id: string, input: UpdateTagDto): Promise<TagView> {
    const row = await this.db
      .withTenant(async (tx) => {
        await this.system.ensure(tx);
        const [cur] = await tx.select().from(tags).where(and(eq(tags.id, id), isNull(tags.deletedAt))).for('update').limit(1);
        if (!cur) throw new NotFoundError();
        if (cur.isSystem) throw this.systemTag();
        const set: Partial<typeof tags.$inferInsert> = {};
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        if (input.name !== undefined && input.name !== cur.name) {
          set.name = input.name;
          changes.push({ field: 'name', oldValue: cur.name, newValue: input.name });
        }
        if (input.color !== undefined && input.color !== cur.color) {
          set.color = input.color;
          changes.push({ field: 'color', oldValue: cur.color, newValue: input.color });
        }
        if (changes.length === 0) return cur;
        const [updated] = await tx.update(tags).set(set).where(eq(tags.id, id)).returning();
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        return updated!;
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return toTagView(row);
  }

  /** Borrado lógico: la etiqueta deja de verse y de poder ponerse; los contactos conservan el vínculo pero ya no lo muestran. Se anuncia en el `TagChangeBus` (M7.3: GoHighLevel la elimina también). */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(tags).where(and(eq(tags.id, id), isNull(tags.deletedAt))).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      if (cur.isSystem) throw this.systemTag();
      await tx.update(tags).set({ deletedAt: new Date() }).where(eq(tags.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, oldValue: { name: cur.name, color: cur.color }, source: 'manual' });
      await this.bus.emitDeleted(tx, { tagName: cur.name, origin: 'local' }); // un canal externo (GoHighLevel) también la borra
    });
    return { id, deleted: true };
  }

  private systemTag(): ConflictError {
    return new ConflictError('TAG_SYSTEM', 'Las etiquetas del sistema no se pueden cambiar ni borrar: las pone el sistema');
  }

  private nameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'tags_org_name_uq' ? new ConflictError('TAG_EXISTS', 'Ya existe una etiqueta con ese nombre') : undefined;
  }
}
