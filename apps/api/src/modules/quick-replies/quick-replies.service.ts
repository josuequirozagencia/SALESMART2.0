import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull, or, sql } from 'drizzle-orm';
import { Database, quickReplies, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CustomValuesService, type CustomValues } from '../custom-fields';
import { MAX_QUICK_REPLIES_PER_SCOPE, type CreateQuickReplyDto, type UpdateQuickReplyDto } from './quick-replies.dto';
import { customKeysIn, resolve, unknownVariables, variablesIn, type ResolveContext } from './quick-reply-model';

type Row = typeof quickReplies.$inferSelect;

export interface QuickReplyView {
  id: string;
  shortcut: string;
  /** El texto tal como se guardó, con las variables sin resolver. */
  body: string;
  shared: boolean;
  /** ¿La escribí yo? (si no, es una compartida por otra persona). */
  mine: boolean;
  /** ¿Puedo cambiarla o borrarla? Las personales, su dueño; las compartidas, quien tiene `quick_replies.manage`. */
  can_edit: boolean;
  /** Variables que usa el texto. */
  variables: string[];
  updated_at: string;
}

/** Una respuesta lista para insertar en una conversación concreta. */
export interface ResolvedQuickReplyView extends QuickReplyView {
  /** El texto con las variables resueltas; lo que no se pudo queda como `{{variable}}`. */
  text: string;
  missing: string[];
}

const AUDIT = 'quick_reply';

/**
 * Respuestas rápidas (M5.6b, ADR-50): textos guardados que se insertan en el redactor con `/atajo`. Personales por defecto (solo su dueño las ve y usa); compartidas con toda
 * la empresa solo por quien tiene `quick_replies.manage`. Crear y usar las propias basta con poder responder (`inbox.reply`). Ver el listado va con `inbox.read`.
 * Las variables se validan al guardar (una desconocida se rechaza con el nombre) y se resuelven al insertar en una conversación, con los datos de SU contacto: nunca de otro.
 */
@Injectable()
export class QuickRepliesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
  ) {}

  async list(manage: boolean): Promise<{ items: QuickReplyView[] }> {
    const userId = this.userId();
    const rows = await this.db.withTenant((tx) => this.visible(tx, userId));
    return { items: rows.map((r) => this.view(r, userId, manage)) };
  }

  async create(manage: boolean, input: CreateQuickReplyDto): Promise<QuickReplyView> {
    const userId = this.userId();
    const shared = input.shared ?? false;
    if (shared && !manage) throw this.noShare();
    const row = await this.db
      .withTenant(async (tx) => {
        await this.assertVariables(tx, input.body);
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(quickReplies)
          .where(and(isNull(quickReplies.deletedAt), shared ? eq(quickReplies.shared, true) : and(eq(quickReplies.shared, false), eq(quickReplies.ownerId, userId))));
        if (n >= MAX_QUICK_REPLIES_PER_SCOPE) throw new ConflictError('QUICK_REPLY_LIMIT', `Se alcanzó el máximo de ${MAX_QUICK_REPLIES_PER_SCOPE} respuestas rápidas${shared ? ' compartidas' : ''}. Borra alguna para crear otra`);
        const [created] = await tx.insert(quickReplies).values({ ownerId: userId, shortcut: input.shortcut, body: input.body, shared }).returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: created!.id, newValue: { shortcut: created!.shortcut, body: created!.body, shared }, source: 'manual' });
        return created!;
      })
      .catch((e: unknown) => {
        throw this.taken(e) ?? e;
      });
    return this.view(row, userId, manage);
  }

  async update(manage: boolean, id: string, input: UpdateQuickReplyDto): Promise<QuickReplyView> {
    const userId = this.userId();
    if (input.shared === true && !manage) throw this.noShare();
    const row = await this.db
      .withTenant(async (tx) => {
        const cur = await this.editable(tx, userId, manage, id);
        const set: Partial<Row> = {};
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        if (input.shortcut !== undefined && input.shortcut !== cur.shortcut) {
          set.shortcut = input.shortcut;
          changes.push({ field: 'shortcut', oldValue: cur.shortcut, newValue: input.shortcut });
        }
        if (input.body !== undefined && input.body !== cur.body) {
          await this.assertVariables(tx, input.body);
          set.body = input.body;
          changes.push({ field: 'body', oldValue: cur.body, newValue: input.body });
        }
        if (input.shared !== undefined && input.shared !== cur.shared) {
          set.shared = input.shared;
          changes.push({ field: 'shared', oldValue: cur.shared, newValue: input.shared });
        }
        if (changes.length === 0) return cur;
        const [updated] = await tx.update(quickReplies).set({ ...set, updatedAt: new Date() }).where(eq(quickReplies.id, id)).returning();
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        return updated!;
      })
      .catch((e: unknown) => {
        throw this.taken(e) ?? e;
      });
    return this.view(row, userId, manage);
  }

  /** Borrado lógico. */
  async remove(manage: boolean, id: string): Promise<{ id: string; deleted: true }> {
    const userId = this.userId();
    await this.db.withTenant(async (tx) => {
      const cur = await this.editable(tx, userId, manage, id);
      await tx.update(quickReplies).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(quickReplies.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, oldValue: { shortcut: cur.shortcut, shared: cur.shared }, source: 'manual' });
    });
    return { id, deleted: true };
  }

  /**
   * Las respuestas que esta persona puede usar (las suyas y las compartidas) ya resueltas para el contacto de una conversación. Va dentro de la transacción de quien llama,
   * que ya comprobó que la persona puede responder esa conversación. Solo se leen del contacto los campos personalizados que alguna respuesta usa.
   */
  async resolvedFor(tx: TenantTx, contactId: string, base: Omit<ResolveContext, 'custom'>): Promise<{ items: ResolvedQuickReplyView[] }> {
    const userId = this.userId();
    const rows = await this.visible(tx, userId);
    const wanted = new Set(rows.flatMap((r) => customKeysIn(r.body)));
    const values: CustomValues = wanted.size === 0 ? {} : ((await this.custom.valuesFor(tx, 'contact', [contactId])).get(contactId) ?? {});
    const custom = Object.fromEntries(Object.entries(values).filter(([k]) => wanted.has(k)));
    const ctx: ResolveContext = { ...base, custom };
    return {
      items: rows.map((r) => {
        const out = resolve(r.body, ctx);
        // `manage` no importa aquí: el selector solo inserta, no edita
        return { ...this.view(r, userId, false), text: out.text, missing: out.missing };
      }),
    };
  }

  private async visible(tx: TenantTx, userId: string): Promise<Row[]> {
    return tx
      .select()
      .from(quickReplies)
      .where(and(isNull(quickReplies.deletedAt), or(eq(quickReplies.shared, true), eq(quickReplies.ownerId, userId))))
      .orderBy(asc(quickReplies.shortcut), sql`${quickReplies.shared} DESC`);
  }

  /** La respuesta si la persona puede CAMBIARLA: 404 si no la ve (de otra persona, no compartida, o de otra empresa), 403 si la ve pero no es suya ni puede administrar las compartidas. */
  private async editable(tx: TenantTx, userId: string, manage: boolean, id: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(quickReplies)
      .where(and(eq(quickReplies.id, id), isNull(quickReplies.deletedAt), or(eq(quickReplies.shared, true), eq(quickReplies.ownerId, userId))))
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundError();
    if (!this.canEdit(row, userId, manage)) throw new ForbiddenError('QUICK_REPLY_NOT_YOURS', 'Esta respuesta es compartida: solo el administrador puede cambiarla');
    return row;
  }

  private canEdit(r: Row, userId: string, manage: boolean): boolean {
    return r.shared ? manage : r.ownerId === userId;
  }

  private view(r: Row, userId: string, manage: boolean): QuickReplyView {
    return {
      id: r.id,
      shortcut: r.shortcut,
      body: r.body,
      shared: r.shared,
      mine: r.ownerId === userId,
      can_edit: this.canEdit(r, userId, manage),
      variables: variablesIn(r.body),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  /** Rechaza el texto si usa una variable que no existe, diciendo cuál (un campo personalizado archivado ya no se puede usar en respuestas nuevas). */
  private async assertVariables(tx: TenantTx, body: string): Promise<void> {
    const active = new Set((await this.custom.labels(tx, 'contact')).map((f) => f.key));
    const bad = unknownVariables(body, active);
    if (bad.length > 0) throw new ValidationError(bad.map((v) => ({ path: 'body', code: 'unknown_variable', message: `La variable «{{${v}}}» no existe. Usa las variables de la lista o un campo personalizado como {{contact.clave}}` })));
  }

  private userId(): string {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return userId;
  }

  private noShare(): ForbiddenError {
    return new ForbiddenError('QUICK_REPLY_SHARE_NOT_ALLOWED', 'Solo el administrador puede compartir respuestas rápidas con toda la empresa');
  }

  private taken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    if (cause?.code !== '23505') return undefined;
    if (cause.constraint === 'quick_replies_shared_shortcut_uq') return new ConflictError('QUICK_REPLY_EXISTS', 'Ya hay una respuesta compartida con ese atajo');
    if (cause.constraint === 'quick_replies_owner_shortcut_uq') return new ConflictError('QUICK_REPLY_EXISTS', 'Ya tienes una respuesta con ese atajo');
    return undefined;
  }
}
