import { Inject, Injectable } from '@nestjs/common';
import { and, inArray, sql } from 'drizzle-orm';
import { Database, messages } from '../../db';
import { OrgMembersService } from '../organizations';

/** La cita que un mensaje lleva dentro (v13 S3.3): de qué mensaje es respuesta, en pocas palabras. */
export interface QuoteView {
  id: string;
  direction: 'in' | 'out';
  sender_type: string;
  /** Quién escribió el mensaje citado, si es de una persona del equipo. */
  author: { id: string; name: string } | null;
  kind: string;
  /** Texto o pie del mensaje citado, recortado; null si no tiene (una imagen sin pie, una ubicación…). */
  text: string | null;
}

const MAX_QUOTE_TEXT = 160;

/**
 * Resuelve, por lote, las citas de los mensajes que responden a otro. Solo mensajes de la misma empresa (la consulta ya va acotada por RLS) y nunca una nota interna: si el citado ya no
 * existe o es una nota, el mensaje se ve sin cita. El texto es dato personal: no va a logs.
 */
@Injectable()
export class MessageQuotesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  /** Mapa «id del mensaje que responde» → su cita. */
  async forRows(rows: ReadonlyArray<{ id: string; replyToMessageId: string | null }>): Promise<Map<string, QuoteView>> {
    const targets = [...new Set(rows.flatMap((r) => (r.replyToMessageId ? [r.replyToMessageId] : [])))];
    if (targets.length === 0) return new Map();
    const found = await this.db.withTenant((tx) =>
      tx
        .select({ id: messages.id, direction: messages.direction, senderType: messages.senderType, kind: messages.kind, body: messages.body, createdBy: messages.createdBy })
        .from(messages)
        .where(and(inArray(messages.id, targets), sql`${messages.kind} <> 'note'`)),
    );
    const byId = new Map(found.map((f) => [f.id, f]));
    const labels = await this.members.labels(found.map((f) => f.createdBy).filter((x): x is string => x !== null));
    const out = new Map<string, QuoteView>();
    for (const r of rows) {
      const t = r.replyToMessageId ? byId.get(r.replyToMessageId) : undefined;
      if (!t) continue;
      const text = t.body?.replace(/\s+/g, ' ').trim() ?? '';
      out.set(r.id, {
        id: t.id,
        direction: t.direction as 'in' | 'out',
        sender_type: t.senderType,
        author: t.createdBy ? (labels.get(t.createdBy) ?? { id: t.createdBy, name: 'Persona desconocida' }) : null,
        kind: t.kind,
        text: text === '' ? null : text.length > MAX_QUOTE_TEXT ? `${text.slice(0, MAX_QUOTE_TEXT - 1)}…` : text,
      });
    }
    return out;
  }
}
