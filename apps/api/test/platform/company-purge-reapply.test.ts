// F3c (ADR-59 «Copias de seguridad») — reaplicar borrados definitivos tras restaurar una copia antigua: una empresa que ya se había purgado «resucita» en la copia (viva, con sus datos) y el guion la vuelve a borrar con
// las mismas funciones del borrado normal, sin tocar a nadie más.
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseOrgIds, reapplyPurges } from '../../src/db/reapply-purges';
import { requireDb } from '../support/harness';

const info = requireDb();
// Empresas PROPIAS de esta prueba: las constantes ORG_A/ORG_B son las de los fixtures de aislamiento (fx_*) y el borrado definitivo vaciaría también esas filas de la base compartida
const ORG_A = 'f3c0a000-0000-4000-8000-00000000000a';
const ORG_B = 'f3c0b000-0000-4000-8000-00000000000b';
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$x$y';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  owner: 'a0000000-0000-4000-8000-00000000000a',
  bob: 'b0000000-0000-4000-8000-00000000000b',
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;

async function contactsOf(org: string): Promise<number> {
  return (await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1`, [org])).rows[0].n as number;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
});
afterAll(async () => { await admin.end(); });
beforeEach(async () => {
  await admin.query('TRUNCATE organization_deletions, organization_members, organizations, users, platform_audit, contact_phones, contacts CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  for (const [id, email] of [[IDS.owner, 'owner@a.test'], [IDS.bob, 'bob@b.test'], [IDS.root, 'root@plat.test']]) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, HASH]);
  for (const [u, o, r] of [[IDS.owner, ORG_A, 'client_admin'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']]) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  for (const org of [ORG_A, ORG_B]) await admin.query(`INSERT INTO contacts(id, organization_id, name) SELECT gen_random_uuid(), $1, 'Resucitado ' || g FROM generate_series(1, 4) g`, [org]);
});

describe('parseOrgIds', () => {
  it('lee un id por línea, ignora comentarios y vacías, quita repetidos y rechaza lo que no es un id', () => {
    expect(parseOrgIds(`# empresas purgadas\n${ORG_A}\n\n${ORG_B}  # otra\n${ORG_A.toUpperCase()}\r\n`)).toEqual([ORG_A, ORG_B]);
    expect(() => parseOrgIds('no-es-un-id')).toThrow(/no es un id de empresa válido/);
    expect(() => parseOrgIds(`${ORG_A}; DROP TABLE contacts`)).toThrow(/no es un id de empresa válido/);
    expect(parseOrgIds('')).toEqual([]);
  });
});

describe('reapplyPurges', () => {
  it('vuelve a borrar la empresa que la copia trajo de vuelta, no toca a las demás y es idempotente', async () => {
    const r = await reapplyPurges(info.ownerUrl, [ORG_A, '99999999-9999-4999-8999-999999999999', IDS.platformOrg], IDS.root);
    expect(r.map((x) => `${x.outcome}`)).toEqual(['purged', 'not_found', 'refused']);
    expect(r[0]!.counts).toMatchObject({ contacts: 4, 'identity.organization_members': 1, 'identity.users': 1 });
    expect(r[2]!.detail).toMatch(/platform/);
    // A, borrada y reducida a lápida; B y la plataforma, intactas
    expect(await contactsOf(ORG_A)).toBe(0);
    expect((await admin.query(`SELECT name, status FROM organizations WHERE id = $1`, [ORG_A])).rows[0]).toEqual({ name: '[empresa eliminada]', status: 'purged' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [IDS.owner])).rows[0].n).toBe(0);
    expect(await contactsOf(ORG_B)).toBe(4);
    expect((await admin.query(`SELECT status FROM organizations WHERE id = $1`, [ORG_B])).rows[0].status).toBe('active');
    expect((await admin.query(`SELECT status FROM organizations WHERE id = $1`, [IDS.platformOrg])).rows[0].status).toBe('active');
    // queda constancia de la eliminación sintética, cerrada
    const d = (await admin.query(`SELECT state, reason, requested_by, purge_counts FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).rows[0];
    expect(d).toMatchObject({ state: 'purged', requested_by: IDS.root });
    expect(d.reason).toMatch(/Reaplicación/);
    expect(d.purge_counts).toMatchObject({ reapplied: true, contacts: 4 });

    const again = await reapplyPurges(info.ownerUrl, [ORG_A], IDS.root);
    expect(again[0]!.outcome).toBe('already_purged');
    expect(await contactsOf(ORG_B)).toBe(4);
  });

  it('también cierra una eliminación que quedó a medias en la copia (programada o en curso)', async () => {
    await admin.query(`UPDATE organizations SET status = 'deleted', deleted_at = now() WHERE id = $1`, [ORG_A]);
    await admin.query(`INSERT INTO organization_deletions(id, organization_id, requested_by, reason, organization_name, previous_status, requested_at, purge_after, state) VALUES (gen_random_uuid(), $1, $2, 'Cierre pedido por el dueño', 'x', 'active', now() - interval '2 days', now() + interval '5 days', 'scheduled')`, [ORG_A, IDS.root]);
    const r = await reapplyPurges(info.ownerUrl, [ORG_A], IDS.root);
    expect(r[0]!.outcome).toBe('purged');
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1); // reutiliza la fila abierta
    expect((await admin.query(`SELECT state FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).rows[0].state).toBe('purged');
  });

  it('exige un actor que exista en la base restaurada', async () => {
    await expect(reapplyPurges(info.ownerUrl, [ORG_A], 'aaaaaaaa-0000-4000-8000-000000000000')).rejects.toThrow(/actor/);
    expect(await contactsOf(ORG_A)).toBe(4);
  });
});
