import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { Database } from '../../../db';
import { ValidationError } from '../../../errors';
import { likeEscape } from '../../organizations';
import type { ListAccessSessionsQuery } from './context.dto';

export interface AccessSessionItem {
  id: string;
  actor: { email: string; name: string | null };
  actor_role: 'super_admin' | 'agency';
  organization: { id: string; name: string; kind: string };
  started_at: string;
  /** Cuándo salió (o cuándo terminó su sesión si no salió expresamente). null = sigue dentro. */
  ended_at: string | null;
  end_reason: 'switch' | 'return' | 'access_removed' | 'session_ended' | null;
  open: boolean;
  duration_seconds: number;
}
export interface AccessSessionList {
  items: AccessSessionItem[];
  next_cursor: string | null;
}

type Row = {
  id: string;
  actor_role: 'super_admin' | 'agency';
  started_at: Date | string;
  ended_at: Date | string | null;
  end_reason: AccessSessionItem['end_reason'];
  actor_email: string;
  actor_name: string | null;
  org_id: string;
  org_name: string;
  org_kind: string;
};

const iso = (d: Date | string): string => new Date(d).toISOString();

/**
 * Historial de accesos (ADR-22/41): quién entró a qué organización, cuándo y cuánto tiempo. SOLO el Súper Admin lo lee (permiso
 * `platform.access_log.read` en el controlador); en la BD solo lo toca `app_identity`. Una entrada sin cierre expreso se cierra con su sesión:
 * mientras la tarea de limpieza no la haya cerrado, el fin se deduce de la sesión (revocada o vencida), de modo que nunca aparece «dentro» una sesión muerta.
 */
@Injectable()
export class AccessSessionsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(f: ListAccessSessionsQuery, now = new Date()): Promise<AccessSessionList> {
    const where: SQL[] = [sql`true`];
    if (f.actor_role) where.push(sql`x.actor_role = ${f.actor_role}`);
    if (f.open === 'true') where.push(sql`x.eff_end IS NULL`);
    if (f.open === 'false') where.push(sql`x.eff_end IS NOT NULL`);
    if (f.q) {
      const like = `%${likeEscape(f.q)}%`;
      where.push(sql`(x.actor_email ILIKE ${like} ESCAPE '!' OR x.actor_name ILIKE ${like} ESCAPE '!' OR x.org_name ILIKE ${like} ESCAPE '!')`);
    }
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      where.push(sql`(x.started_at, x.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await this.db.withIdentity(async (tx) => {
      const res = await tx.execute<Row & { eff_end: Date | string | null; eff_reason: AccessSessionItem['end_reason'] }>(sql`
        SELECT * FROM (
          SELECT a.id, a.actor_role, a.started_at, a.ended_at, a.end_reason, u.email AS actor_email, u.full_name AS actor_name,
                 o.id AS org_id, o.name AS org_name, o.kind AS org_kind,
                 COALESCE(a.ended_at, se.session_end) AS eff_end,
                 COALESCE(a.end_reason, CASE WHEN se.session_end IS NOT NULL THEN 'session_ended' END) AS eff_reason
            FROM access_sessions a
            JOIN users u ON u.id = a.actor_user_id
            JOIN organizations o ON o.id = a.organization_id
            LEFT JOIN LATERAL (
              SELECT COALESCE(s.revoked_at, CASE WHEN s.refresh_expires_at <= ${now} OR s.absolute_expires_at <= ${now} THEN LEAST(s.refresh_expires_at, s.absolute_expires_at) END) AS session_end
                FROM sessions s WHERE s.id = a.session_id
            ) se ON true
        ) x
        WHERE ${sql.join(where, sql` AND `)}
        ORDER BY x.started_at DESC, x.id DESC
        LIMIT ${f.limit + 1}`);
      return res.rows;
    });
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const end = r.eff_end ? new Date(r.eff_end) : null;
        const started = new Date(r.started_at);
        return {
          id: r.id,
          actor: { email: r.actor_email, name: r.actor_name },
          actor_role: r.actor_role,
          organization: { id: r.org_id, name: r.org_name, kind: r.org_kind },
          started_at: iso(r.started_at),
          ended_at: end ? end.toISOString() : null,
          end_reason: r.eff_reason,
          open: end === null,
          duration_seconds: Math.max(0, Math.floor(((end ?? now).getTime() - started.getTime()) / 1000)),
        };
      }),
      next_cursor: rows.length > f.limit && last ? encodeCursor(new Date(last.started_at), last.id) : null,
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (at: Date, id: string): string => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(raw: string): { at: string; id: string } {
  const bad = (): never => {
    throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  };
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !UUID_RE.test(id)) return bad();
  return { at, id };
}
