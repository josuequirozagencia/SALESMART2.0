/**
 * Reaplicar borrados definitivos tras restaurar una copia de seguridad (F3c, ADR-59 «Copias de seguridad y datos personales»). Una copia antigua puede traer de vuelta una empresa que ya se había borrado de forma
 * definitiva; antes de reabrir el servicio hay que borrarla otra vez con LAS MISMAS funciones del borrado normal (`purge_company_step` y `purge_company_identity`). Corre con el rol app_owner, NUNCA desde la API.
 * Los archivos del almacenamiento y las instancias de Evolution no se restauran con la base de datos (siguen borrados), así que aquí solo se rehace la base.
 */
import { Pool } from 'pg';

export type ReapplyOutcome = 'purged' | 'already_purged' | 'not_found' | 'refused';

export interface ReapplyResult {
  organizationId: string;
  outcome: ReapplyOutcome;
  detail?: string;
  /** Filas borradas por tabla (negocio e identidad). */
  counts?: Record<string, number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lee una lista de empresas: un id por línea; `#` comenta; las líneas vacías se ignoran. Un id mal escrito es un error (no se adivina). */
export function parseOrgIds(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    if (!UUID.test(line)) throw new Error(`no es un id de empresa válido: «${line.slice(0, 60)}»`);
    ids.push(line.toLowerCase());
  }
  return [...new Set(ids)];
}

/**
 * Vuelve a borrar de forma definitiva cada empresa de la lista. `actorUserId` es el Súper Admin que queda como autor de la eliminación sintética (debe existir). Es idempotente: una empresa ya borrada se informa
 * como `already_purged` y una que la copia no trae (`not_found`) no necesita nada.
 */
export async function reapplyPurges(ownerUrl: string, orgIds: readonly string[], actorUserId: string): Promise<ReapplyResult[]> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  const out: ReapplyResult[] = [];
  try {
    const actor = await pool.query('SELECT 1 FROM users WHERE id = $1', [actorUserId]);
    if (actor.rowCount === 0) throw new Error('el actor (--actor) no existe en esta base de datos: usa el id de un Súper Admin');
    for (const organizationId of orgIds) {
      const org = (await pool.query<{ kind: string; status: string }>('SELECT kind, status FROM organizations WHERE id = $1', [organizationId])).rows[0];
      if (!org) {
        out.push({ organizationId, outcome: 'not_found', detail: 'la copia no trae esta empresa' });
        continue;
      }
      if (org.status === 'purged') {
        out.push({ organizationId, outcome: 'already_purged' });
        continue;
      }
      if (org.kind !== 'client' && org.kind !== 'agency') {
        out.push({ organizationId, outcome: 'refused', detail: `no se borra una empresa de tipo ${org.kind}` });
        continue;
      }

      // La eliminación sintética: la empresa pasa a «eliminada» con un plazo ya vencido y una eliminación en curso, que es lo que las funciones exigen
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE organizations SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`, [organizationId]);
        const open = await c.query<{ id: string }>(`SELECT id FROM organization_deletions WHERE organization_id = $1 AND state IN ('scheduled', 'purging', 'purge_failed') LIMIT 1`, [organizationId]);
        if (open.rowCount === 0) {
          await c.query(
            `INSERT INTO organization_deletions(id, organization_id, requested_by, reason, organization_name, previous_status, requested_at, purge_after, state, purge_started_at)
             VALUES (gen_random_uuid(), $1, $2, 'Reaplicación del borrado tras restaurar una copia de seguridad', (SELECT name FROM organizations WHERE id = $1), 'active', now() - interval '8 days', now() - interval '1 day', 'purging', now())`,
            [organizationId, actorUserId],
          );
        } else {
          await c.query(
            `UPDATE organization_deletions SET state = 'purging', purge_after = LEAST(purge_after, now() - interval '1 minute'), requested_at = LEAST(requested_at, now() - interval '8 days'), purge_started_at = COALESCE(purge_started_at, now()) WHERE id = $1`,
            [open.rows[0]!.id],
          );
        }
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }

      const counts: Record<string, number> = {};
      for (let pass = 0; pass < 2000; pass++) {
        const rows = (await pool.query<{ table_name: string; deleted: string; remaining: string }>('SELECT * FROM public.purge_company_step($1::uuid)', [organizationId])).rows;
        let deleted = 0;
        let remaining = 0;
        for (const r of rows) {
          deleted += Number(r.deleted);
          remaining += Number(r.remaining);
          if (Number(r.deleted) > 0) counts[r.table_name] = (counts[r.table_name] ?? 0) + Number(r.deleted);
        }
        if (deleted === 0) {
          if (remaining > 0) throw new Error(`no se pudo vaciar la empresa ${organizationId}: quedan ${remaining} filas`);
          break;
        }
      }
      for (const r of (await pool.query<{ table_name: string; deleted: string }>('SELECT * FROM public.purge_company_identity($1::uuid)', [organizationId])).rows) {
        if (Number(r.deleted) > 0) counts[`identity.${r.table_name}`] = Number(r.deleted);
      }
      await pool.query(
        `UPDATE organization_deletions SET state = 'purged', purged_at = now(), purge_counts = $2::jsonb, purge_lease_until = NULL, purge_error = NULL WHERE organization_id = $1 AND state = 'purging'`,
        [organizationId, JSON.stringify({ reapplied: true, ...counts })],
      );
      out.push({ organizationId, outcome: 'purged', counts });
    }
    return out;
  } finally {
    await pool.end();
  }
}
