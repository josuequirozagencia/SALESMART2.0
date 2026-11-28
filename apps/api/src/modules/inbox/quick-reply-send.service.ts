import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import { conversations, Database, messageAttachments, messages, quickReplySends, type TenantTx } from '../../db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AttachmentsService, type PreparedFile } from '../attachments';
import { writeAudit } from '../audit';
import { LibraryService, type LibraryAccess } from '../library';
import { OrgDirectoryService } from '../organizations';
import { QuickRepliesService } from '../quick-replies';
import { RealtimeService } from '../realtime';
import { SlaService } from '../sla';
import { assertCanReply, assertWindowOpen, loadConversation, scopeOf, type InboxAccess, type InboxScope } from './inbox.access';
import type { SendQuickReplyDto } from './inbox.dto';
import type { MessageView } from './inbox.views';
import { OutboundService } from './outbound.service';
import { planQuickReply } from './quick-reply-plan';

type AssetRow = NonNullable<ReturnType<Awaited<ReturnType<LibraryService['forLinks']>>['get']>>;
interface Copy {
  id: string;
  key: string;
  scan: 'clean' | 'skipped';
  file: PreparedFile;
}

const KIND_LABEL: Record<string, string> = { image: 'imagen', video: 'video', audio: 'audio', document: 'documento' };
const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Enviar una respuesta rápida con sus archivos (V25, ADR-76). Sale TODO o NADA:
 *  1. se comprueba, sin escribir, que la persona puede responder, que la respuesta es suya o compartida y que cada archivo sigue disponible para ella;
 *  2. cada archivo se COPIA a un adjunto propio (fuera de la transacción: es almacenamiento externo);
 *  3. UNA transacción: bloquea la conversación, vuelve a comprobar, guarda la llave y los mensajes en orden (`sent_at` creciente: el despachador no adelanta uno a otro) y detiene el SLA.
 *     Si algo falla, las copias se borran.
 * Son mensajes humanos de quien los envía. El texto y los nombres de archivo no van a la auditoría ni a los registros.
 */
@Injectable()
export class QuickReplySendService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QuickRepliesService) private readonly replies: QuickRepliesService,
    @Inject(LibraryService) private readonly library: LibraryService,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
  ) {}

  async send(access: InboxAccess, lib: LibraryAccess, conversationId: string, replyId: string, key: string, dto: SendQuickReplyDto): Promise<{ messages: MessageView[]; created: boolean }> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    const hash = createHash('sha256').update(JSON.stringify([conversationId, replyId, dto.text ?? '', dto.asset_ids ?? null])).digest('hex');

    const first = await this.db.withTenant(async (tx) => {
      const prior = await this.prior(tx, scope, key, hash);
      if (prior) return { prior };
      const checked = await this.check(tx, scope, lib, conversationId, replyId, dto, false);
      return { checked };
    });
    if (first.prior) return { messages: await this.views(first.prior), created: false };
    const { rows, text } = first.checked;

    const organizationId = TenantContext.current().organizationId;
    const copies: Copy[] = [];
    let saved = false;
    try {
      for (const row of rows) {
        const bytes = await this.library.readObject(row);
        const file = await this.files.prepareUpload(bytes, row.mimeType, row.name);
        const id = uuidv7();
        const stored = await this.files.scanAndStore(organizationId, id, file);
        copies.push({ id, key: stored.key, scan: stored.scanStatus, file });
      }
      const timeZone = (await this.directory.current()).timeZone;
      const result = await this.db.withTenant(async (tx) => {
        // Primero el candado de la conversación: así dos peticiones iguales a la vez se ponen en fila y la segunda ve la llave de la primera
        await loadConversation(tx, scope, conversationId, true);
        const prior = await this.prior(tx, scope, key, hash);
        if (prior) return { ids: prior, created: false };
        // Se revalida con la conversación bloqueada: entre la comprobación y aquí pudo cerrarse, vencer la ventana o archivarse un archivo
        const again = await this.check(tx, scope, lib, conversationId, replyId, dto, true);
        const now = new Date();
        const plan = planQuickReply(text, copies.map((c) => ({ id: c.id, kind: c.file.kind as 'image' }))); // la biblioteca no admite stickers
        const ids: string[] = [];
        for (const [i, part] of plan.entries()) {
          const at = new Date(now.getTime() + i);
          const [m] = await tx
            .insert(messages)
            .values({ conversationId, channelAccountId: again.channelId, direction: 'out', senderType: 'human', kind: part.kind, body: part.body, meta: {}, status: 'queued', sentAt: at, createdBy: scope.userId, attempts: 0, nextAttemptAt: now })
            .returning({ id: messages.id });
          ids.push(m!.id);
          const copy = copies.find((c) => c.id === part.fileId);
          if (copy) {
            await tx.insert(messageAttachments).values({ id: copy.id, conversationId, messageId: m!.id, direction: 'out', kind: copy.file.kind, mimeType: copy.file.mime, filename: copy.file.filename, sizeBytes: copy.file.bytes.length, storageKey: copy.key, checksum: copy.file.checksum, state: 'ready', scanStatus: copy.scan, createdBy: scope.userId });
          }
        }
        // La llave se guarda en la misma transacción: si dos peticiones iguales llegan a la vez, una choca con la clave primaria y no envía nada
        await tx.insert(quickReplySends).values({ idempotencyKey: key, userId: scope.userId, conversationId, quickReplyId: replyId, requestHash: hash, messageIds: ids });
        const stamp = new Date(now.getTime() + plan.length - 1).toISOString();
        await tx
          .update(conversations)
          .set({ status: 'waiting', lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${stamp}::timestamptz), ${stamp}::timestamptz)`, unreadCount: 0, updatedAt: now })
          .where(eq(conversations.id, conversationId));
        await this.sla.stopOnReply(tx, conversationId, ids[0]!, { now, timeZone });
        if (again.status === 'pending') await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'status', oldValue: 'pending', newValue: 'waiting' });
        await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'quick_reply', newValue: { quick_reply_id: replyId, files: copies.length, kinds: copies.map((c) => c.file.kind) }, source: 'manual' });
        this.realtime?.touchHere(conversationId);
        return { ids, created: true };
      });
      saved = result.created;
      if (!result.created) return { messages: await this.views(result.ids), created: false };
      // En orden: cada intento solo sale si no queda uno anterior en cola; lo que no salga ahora lo toma la tarea periódica
      const sent: MessageView[] = [];
      for (const id of result.ids) sent.push(await this.outbound.sendNow(id));
      return { messages: sent, created: true };
    } finally {
      if (!saved) for (const c of copies) await this.files.remove(c.key);
    }
  }

  /** Los mensajes de un envío anterior con esta llave (misma persona y misma petición); con otros datos, 409. */
  private async prior(tx: TenantTx, scope: InboxScope, key: string, hash: string): Promise<string[] | null> {
    const [row] = await tx.select().from(quickReplySends).where(eq(quickReplySends.idempotencyKey, key)).limit(1);
    if (!row) return null;
    if (row.userId !== scope.userId || row.requestHash !== hash) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Esa llave ya se usó con otros datos');
    await loadConversation(tx, scope, row.conversationId);
    return row.messageIds;
  }

  /** Todo lo que debe cumplirse para enviar, sin escribir. Con `lock` bloquea la conversación. */
  private async check(tx: TenantTx, scope: InboxScope, lib: LibraryAccess, conversationId: string, replyId: string, dto: SendQuickReplyDto, lock: boolean): Promise<{ rows: AssetRow[]; text: string; channelId: string; status: string }> {
    const { c, channel, collab } = await loadConversation(tx, scope, conversationId, lock);
    assertCanReply(scope, c, channel.state, collab, channel.provider);
    const reply = await this.replies.usable(tx, replyId);
    const wanted = dto.asset_ids ?? reply.assetIds;
    if (wanted.some((id) => !reply.assetIds.includes(id))) throw new ValidationError([{ path: 'asset_ids', code: 'not_in_reply', message: 'Ese archivo no pertenece a esta respuesta' }]);
    const text = dto.text ?? '';
    if (/\{\{[^{}]*\}\}/.test(text)) throw new ValidationError([{ path: 'text', code: 'unresolved_variable', message: 'Completa los datos entre llaves antes de enviar' }]);
    if (wanted.length === 0 && text === '') throw new ValidationError([{ path: 'text', code: 'required', message: 'Escribe un mensaje' }]);
    if (wanted.length > 0 && channel.provider === 'ghl') throw new ConflictError('CHANNEL_NO_MEDIA', 'GoHighLevel no admite archivos: envía solo el texto');
    assertWindowOpen(c.lastInboundAt, new Date(), channel.provider);
    const found = await this.library.forLinks(tx, wanted);
    // En el orden de la respuesta, no en el de la petición
    const rows = reply.assetIds.filter((id) => wanted.includes(id)).map((id) => {
      const f = found.get(id);
      if (!f) throw new NotFoundError();
      if (this.library.problemOf(lib, f) !== null) {
        throw new AppError(409, 'QUICK_REPLY_ASSET_UNAVAILABLE', `Un archivo (${KIND_LABEL[f.kind] ?? 'archivo'}, ${size(f.sizeBytes)}) ya no está disponible: quítalo y envía de nuevo`, [{ path: 'asset_ids', code: 'unavailable', message: f.id }]);
      }
      return f;
    });
    return { rows, text, channelId: c.channelAccountId, status: c.status };
  }

  private async views(ids: readonly string[]): Promise<MessageView[]> {
    const out: MessageView[] = [];
    for (const id of ids) out.push(await this.outbound.sendNow(id));
    return out;
  }
}
