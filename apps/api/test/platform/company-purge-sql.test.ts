// F3c (ADR-59 #10–12) — las DOS funciones SECURITY DEFINER del borrado definitivo, probadas SOLAS contra PostgreSQL real (sin la aplicación): sus defensas, que borran TODO de la empresa y NADA de otra, que
// son idempotentes y por lotes, y que dejan la lápida. Quien las llama en producción es la tarea `company-purge` (company-purge.test.ts).
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireDb } from '../support/harness';

const info = requireDb();
// Empresas PROPIAS de esta prueba: las constantes ORG_A/ORG_B son las de los fixtures de aislamiento (fx_*) y el borrado definitivo vaciaría también esas filas de la base compartida
const ORG_A = 'f3c0a000-0000-4000-8000-00000000000a';
const ORG_B = 'f3c0b000-0000-4000-8000-00000000000b';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  owner: 'a0000000-0000-4000-8000-00000000000a', // administrador SOLO de A
  shared: 'c0000000-0000-4000-8000-0000000000c3', // miembro de A y de B
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  root: 'f0000000-0000-4000-8000-0000000000f1', // Súper Admin
};
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$x$y';
const DELETION_A = '0de1e700-0000-4000-8000-0000000000a1';
const DELETION_B = '0de1e700-0000-4000-8000-0000000000b1';
let admin: Client;

/** Las tablas de negocio, del catálogo: lo mismo que usa la función. */
async function tenantTables(): Promise<string[]> {
  const r = await admin.query(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped) ORDER BY 1`);
  return r.rows.map((x: { t: string }) => x.t);
}
/** Cuenta y huella de las filas de UNA empresa en cada tabla de negocio. */
async function fingerprint(org: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of await tenantTables()) {
    const r = await admin.query(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x WHERE organization_id = $1`, [org]);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}
const rowsOf = async (org: string): Promise<number> => {
  let total = 0;
  for (const t of await tenantTables()) total += (await admin.query(`SELECT count(*)::int AS n FROM "${t}" WHERE organization_id = $1`, [org])).rows[0].n as number;
  return total;
};

async function asRole<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const identity = <T,>(fn: (c: Client) => Promise<T>) => asRole(info.identityUrl, fn);

interface StepRow { table_name: string; deleted: string; remaining: string }
/** Una pasada de la función de negocio (como la tarea: con app_identity). */
const step = (org: string) => identity(async (c) => (await c.query<StepRow>('SELECT * FROM public.purge_company_step($1::uuid)', [org])).rows);
/** Repite hasta que una pasada no borre nada (como hace la tarea) y devuelve lo borrado por tabla y cuántas pasadas hicieron falta. */
async function stepAll(org: string): Promise<{ deleted: Record<string, number>; passes: number; remaining: number }> {
  const deleted: Record<string, number> = {};
  let passes = 0;
  for (;;) {
    const rows = await step(org);
    passes += 1;
    let n = 0;
    for (const r of rows) { deleted[r.table_name] = (deleted[r.table_name] ?? 0) + Number(r.deleted); n += Number(r.deleted); }
    if (n === 0) return { deleted, passes, remaining: rows.reduce((a, r) => a + Number(r.remaining), 0) };
    if (passes > 60) throw new Error('el borrado no termina');
  }
}
interface IdRow { table_name: string; deleted: string }
const identityStep = (org: string) => identity(async (c) => Object.fromEntries((await c.query<IdRow>('SELECT * FROM public.purge_company_identity($1::uuid)', [org])).rows.map((r) => [r.table_name, Number(r.deleted)])));

async function seedOrg(org: string, tag: string, contacts = 3): Promise<void> {
  const pipe = (await admin.query(`INSERT INTO pipelines(organization_id, id, name, position) VALUES ($1, gen_random_uuid(), $2, 0) RETURNING id`, [org, `Ventas ${tag}`])).rows[0].id as string;
  const stage = async (name: string, pos: number, kind: string) => (await admin.query(`INSERT INTO pipeline_stages(organization_id, id, pipeline_id, name, position, kind) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5) RETURNING id`, [org, pipe, name, pos, kind])).rows[0].id as string;
  const nuevo = await stage('Nuevo', 0, 'open');
  const cita = await stage('Cita', 1, 'open');
  await admin.query(`UPDATE pipelines SET appointment_stage_id = $1 WHERE id = $2`, [cita, pipe]); // el ciclo pipelines ↔ pipeline_stages
  const ch = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', $2) RETURNING id`, [org, `Canal ${tag}`])).rows[0].id as string;
  await admin.query(`UPDATE channel_accounts SET credentials_sealed = '\\x0102'::bytea, key_version = 1, token_last4 = '1234' WHERE id = $1`, [ch]);
  for (let i = 0; i < contacts; i++) {
    const c = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, `Contacto ${tag}-${i}`])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, c, `+5939${tag === 'A' ? '7' : '8'}${String(1000000 + i)}`]);
    if (i === 0) {
      await admin.query(`INSERT INTO opportunities(organization_id, id, pipeline_id, stage_id, contact_id, amount, status) VALUES ($1, gen_random_uuid(), $2, $3, $4, 100, 'open')`, [org, pipe, nuevo, c]);
      const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'unassigned', $4) RETURNING id`, [org, c, ch, `+5939${tag === 'A' ? '7' : '8'}1000000`])).rows[0].id as string;
      await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'in', 'contact', 'text', $4, 'received', now())`, [org, conv, ch, `hola ${tag}`]);
    }
  }
}

async function seedIdentity(): Promise<void> {
  await admin.query('TRUNCATE company_exports, organization_deletions, sessions, access_sessions, invitations, view_as_log, member_history, member_permissions, trials, channel_routes, qr_routes, form_routes, ghl_routes, attribution_endpoints, organization_members, organizations, users, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [IDS.agencyOrg, 'agency', 'Agencia Demo']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string]> = [[IDS.owner, 'owner@a.test'], [IDS.shared, 'shared@ab.test'], [IDS.bob, 'bob@b.test'], [IDS.root, 'root@plat.test']];
  for (const [id, email] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),'Persona de prueba')`, [id, email, HASH]);
  const members: Array<[string, string, string]> = [[IDS.owner, ORG_A, 'client_admin'], [IDS.shared, ORG_A, 'advisor'], [IDS.shared, ORG_B, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.owner, ORG_A]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.bob, ORG_B]);
  // rutas, invitaciones y sesiones de cada empresa
  for (const org of [ORG_A, ORG_B]) {
    await admin.query(`INSERT INTO ghl_routes(id, organization_id, secret_hash) VALUES (gen_random_uuid(), $1, $2)`, [org, 'a'.repeat(64)]);
    await admin.query(`INSERT INTO invitations(id, organization_id, email, role, token_hash, invited_by, expires_at) VALUES (gen_random_uuid(), $1, $2, 'advisor', $3, $4, now() + interval '3 days')`, [org, `inv-${org.slice(0, 4)}@x.test`, org === ORG_A ? 'b'.repeat(64) : 'c'.repeat(64), IDS.root]);
  }
  await admin.query(`INSERT INTO sessions(id,user_id,active_org_id,home_org_id,user_session_version,access_hash,access_expires_at,refresh_hash,refresh_expires_at,absolute_expires_at) VALUES (gen_random_uuid(),$1,$2,$2,1,$3,now(),$3,now(),now() + interval '1 day')`, [IDS.owner, ORG_A, 'ab'.repeat(32)]);
  await admin.query(`INSERT INTO sessions(id,user_id,active_org_id,home_org_id,user_session_version,access_hash,access_expires_at,refresh_hash,refresh_expires_at,absolute_expires_at) VALUES (gen_random_uuid(),$1,$2,$2,1,$3,now(),$4,now(),now() + interval '1 day')`, [IDS.bob, ORG_B, 'cd'.repeat(32), 'ef'.repeat(32)]);
}

/** Marca una empresa como eliminada, con su plazo ya vencido (o no). */
async function markDeleted(org: string, deletion: string, opts: { due?: boolean; requestedBy?: string } = {}): Promise<void> {
  await admin.query(`UPDATE organizations SET status = 'deleted', deleted_at = now() - interval '8 days' WHERE id = $1`, [org]);
  await admin.query(
    `INSERT INTO organization_deletions(id, organization_id, requested_by, reason, organization_name, previous_status, requested_at, purge_after, state)
     VALUES ($1, $2, $3, 'Cierre pedido por el dueño', 'x', 'active', now() - interval '8 days', ${opts.due === false ? "now() + interval '3 days'" : "now() - interval '1 day'"}, 'scheduled')`,
    [deletion, org, opts.requestedBy ?? IDS.root],
  );
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
});
afterAll(async () => { await admin.end(); });
beforeEach(async () => {
  await admin.query('TRUNCATE pipelines, pipeline_stages, opportunities, messages, conversations, channel_accounts, contact_phones, contacts CASCADE');
  await seedIdentity();
});

describe('defensas (ADR-59 #11): la función se niega', () => {
  it('con una empresa VIVA, con una eliminada que aún está en su plazo, con la plataforma y con una que no existe', async () => {
    await seedOrg(ORG_A, 'A');
    await seedOrg(ORG_B, 'B');
    const before = await fingerprint(ORG_A);
    await expect(step(ORG_A)).rejects.toThrow(/no está eliminada o su plazo no venció/); // viva
    await markDeleted(ORG_A, DELETION_A, { due: false });
    await expect(step(ORG_A)).rejects.toThrow(/no está eliminada o su plazo no venció/); // eliminada, plazo sin vencer
    await expect(step(IDS.platformOrg)).rejects.toThrow(/no está eliminada/);
    await expect(step('99999999-9999-4999-8999-999999999999')).rejects.toThrow(/no existe/);
    await expect(identityStep(ORG_A)).rejects.toThrow(/no está en borrado definitivo/);
    expect(await fingerprint(ORG_A)).toEqual(before); // no tocó nada
    expect((await admin.query(`SELECT state FROM organization_deletions WHERE id = $1`, [DELETION_A])).rows[0].state).toBe('scheduled');
  });

  it('una eliminación RECUPERADA no habilita el borrado aunque su plazo pasara', async () => {
    await seedOrg(ORG_A, 'A');
    await markDeleted(ORG_A, DELETION_A);
    await admin.query(`UPDATE organization_deletions SET state = 'recovered', recovered_at = now(), recovered_by = $2 WHERE id = $1`, [DELETION_A, IDS.root]);
    await admin.query(`UPDATE organizations SET status = 'active', deleted_at = NULL WHERE id = $1`, [ORG_A]);
    await expect(step(ORG_A)).rejects.toThrow(/no está eliminada/);
    await markDeleted(ORG_B, DELETION_B); // eliminada y vencida: esa sí
    await expect(step(ORG_A)).rejects.toThrow(/no está eliminada/); // B vencida no abre A
  });

  it('solo app_identity puede ejecutarlas: app_rw, app_platform y PUBLIC no', async () => {
    await markDeleted(ORG_A, DELETION_A);
    for (const url of [info.rwUrl, info.platformUrl]) {
      await asRole(url, async (c) => {
        await expect(c.query('SELECT * FROM public.purge_company_step($1::uuid)', [ORG_A])).rejects.toThrow(/permission denied/);
        await expect(c.query('SELECT * FROM public.purge_company_identity($1::uuid)', [ORG_A])).rejects.toThrow(/permission denied/);
      });
    }
  });

  it('el único parámetro es un uuid: no acepta nombres de tabla ni condiciones', async () => {
    await markDeleted(ORG_A, DELETION_A);
    await identity(async (c) => {
      await expect(c.query(`SELECT * FROM public.purge_company_step('contacts; DROP TABLE contacts')`)).rejects.toThrow();
      await expect(c.query(`SELECT * FROM public.purge_company_step($1::uuid, 'contacts')`, [ORG_A])).rejects.toThrow(/does not exist/);
    });
    expect(await tenantTables()).toContain('contacts');
  });

  it('las dos funciones están dadas de alta como SECURITY DEFINER del dueño, con search_path fijo', async () => {
    const r = await admin.query(`SELECT proname, prosecdef, pg_get_userbyid(proowner) AS owner, proconfig FROM pg_proc WHERE proname IN ('purge_company_step', 'purge_company_identity') ORDER BY 1`);
    expect(r.rows).toHaveLength(2);
    for (const f of r.rows as Array<{ prosecdef: boolean; owner: string; proconfig: string[] }>) {
      expect(f.prosecdef).toBe(true);
      expect(f.owner).toBe('app_owner');
      expect(f.proconfig.join()).toMatch(/search_path=pg_catalog, public/);
    }
  });
});

describe('purge_company_step: borra TODO de la empresa y NADA de otra', () => {
  it('vacía las 76 tablas de A (incluido el ciclo de pipelines) y deja idénticas las de B', async () => {
    await seedOrg(ORG_A, 'A', 5);
    await seedOrg(ORG_B, 'B', 4);
    const beforeB = await fingerprint(ORG_B);
    expect(await rowsOf(ORG_A)).toBeGreaterThan(15);
    await markDeleted(ORG_A, DELETION_A);
    const r = await stepAll(ORG_A);
    expect(r.remaining).toBe(0);
    expect(await rowsOf(ORG_A)).toBe(0);
    expect(r.deleted['contacts']).toBe(5);
    expect(r.deleted['messages']).toBe(1);
    expect(r.deleted['pipelines']).toBe(1);
    expect(r.deleted['pipeline_stages']).toBe(2);
    expect(r.passes).toBeGreaterThan(1); // el orden de las claves foráneas necesitó varias pasadas
    expect(await fingerprint(ORG_B)).toEqual(beforeB); // B, idéntica: mismas filas, mismo contenido
    expect((await admin.query(`SELECT state, purge_started_at FROM organization_deletions WHERE id = $1`, [DELETION_A])).rows[0]).toMatchObject({ state: 'purging' });
    expect((await admin.query(`SELECT purge_started_at FROM organization_deletions WHERE id = $1`, [DELETION_A])).rows[0].purge_started_at).not.toBeNull();
  });

  it('cubre toda tabla de negocio que exista: la función no usa una lista a mano', async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThanOrEqual(76);
    await markDeleted(ORG_A, DELETION_A);
    const names = (await step(ORG_A)).map((x) => x.table_name).sort();
    expect(names).toEqual(tables);
  });

  it('es idempotente: volver a llamarla no falla ni borra más', async () => {
    await seedOrg(ORG_A, 'A');
    await markDeleted(ORG_A, DELETION_A);
    await stepAll(ORG_A);
    const again = await step(ORG_A);
    expect(again.every((x) => Number(x.deleted) === 0 && Number(x.remaining) === 0)).toBe(true);
  });

  it('trabaja por lotes de 5000 por tabla y llamada, y se puede retomar', async () => {
    await admin.query(`INSERT INTO contacts(id, organization_id, name) SELECT gen_random_uuid(), $1, 'Masivo ' || g FROM generate_series(1, 5100) g`, [ORG_A]);
    await seedOrg(ORG_B, 'B');
    await markDeleted(ORG_A, DELETION_A);
    const first = (await step(ORG_A)).find((x) => x.table_name === 'contacts')!;
    expect(Number(first.deleted)).toBe(5000);
    expect(Number(first.remaining)).toBe(100);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(100);
    const rest = await stepAll(ORG_A); // «se corta a la mitad y se retoma»
    expect(rest.deleted['contacts']).toBe(100);
    expect(rest.remaining).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1`, [ORG_B])).rows[0].n).toBe(3);
  });

  it('una empresa SIN datos de negocio (p. ej. una agencia) termina sin error', async () => {
    await markDeleted(IDS.agencyOrg, DELETION_B);
    const r = await stepAll(IDS.agencyOrg);
    expect(r.remaining).toBe(0);
  });
});

describe('purge_company_identity', () => {
  it('se niega mientras quede un solo dato de negocio', async () => {
    await seedOrg(ORG_A, 'A');
    await markDeleted(ORG_A, DELETION_A);
    await step(ORG_A); // una pasada: pone la eliminación en `purging` pero aún queda negocio
    await expect(identityStep(ORG_A)).rejects.toThrow(/aún quedan datos de negocio/);
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(2); // la identidad sigue intacta
  });

  it('borra rutas, invitaciones, sesiones y membresías de A; deja la lápida; borra al dueño exclusivo y conserva a quien también está en B; B queda intacta', async () => {
    await seedOrg(ORG_A, 'A');
    const memberB = (await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [ORG_B])).rows[0].n as number;
    await markDeleted(ORG_A, DELETION_A);
    await stepAll(ORG_A);
    const r = await identityStep(ORG_A);
    expect(r).toMatchObject({ ghl_routes: 1, invitations: 1, sessions: 1, organization_members: 2, organizations_tombstone: 1, users: 1, users_anonymized: 0 });
    const q = async (sql: string, p: unknown[] = [ORG_A]) => (await admin.query(sql, p)).rows[0].n as number;
    expect(await q(`SELECT count(*)::int AS n FROM ghl_routes WHERE organization_id = $1`)).toBe(0);
    expect(await q(`SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1`)).toBe(0);
    expect(await q(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`)).toBe(0);
    expect(await q(`SELECT count(*)::int AS n FROM sessions WHERE active_org_id = $1 OR home_org_id = $1`)).toBe(0);
    // la lápida: la fila sigue (las claves foráneas y la auditoría no quedan colgando) pero sin nombre ni dueño ni plan
    expect((await admin.query(`SELECT name, status, owner_user_id, plan_id, kind FROM organizations WHERE id = $1`, [ORG_A])).rows[0]).toEqual({ name: '[empresa eliminada]', status: 'purged', owner_user_id: null, plan_id: null, kind: 'client' });
    // personas
    expect(await q(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [IDS.owner])).toBe(0); // exclusivo de A: se borró
    expect(await q(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [IDS.shared])).toBe(1); // también está en B: se conserva
    expect(await q(`SELECT count(*)::int AS n FROM users WHERE id IN ($1, $2)`, [IDS.root, IDS.bob])).toBe(2);
    expect(await q(`SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [IDS.shared, ORG_B])).toBe(1);
    // B, intacta
    expect(await q(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [ORG_B])).toBe(memberB);
    expect(await q(`SELECT count(*)::int AS n FROM ghl_routes WHERE organization_id = $1`, [ORG_B])).toBe(1);
    expect(await q(`SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1`, [ORG_B])).toBe(1);
    expect(await q(`SELECT count(*)::int AS n FROM sessions WHERE active_org_id = $1`, [ORG_B])).toBe(1);
    expect((await admin.query(`SELECT name, status FROM organizations WHERE id = $1`, [ORG_B])).rows[0]).toEqual({ name: 'Estudio Luna', status: 'active' });
    // la eliminación se conserva como evidencia
    expect((await admin.query(`SELECT organization_name FROM organization_deletions WHERE id = $1`, [DELETION_A])).rows).toHaveLength(1);
  });

  it('una persona exclusiva que sigue referenciada por algo que se conserva se ANONIMIZA en vez de fallar', async () => {
    await seedOrg(ORG_A, 'A');
    await markDeleted(ORG_A, DELETION_A, { requestedBy: IDS.owner }); // la eliminación (que se conserva) apunta al dueño exclusivo
    await stepAll(ORG_A);
    const r = await identityStep(ORG_A);
    expect(r).toMatchObject({ users: 0, users_anonymized: 1 });
    const u = (await admin.query(`SELECT email, full_name, phone, status, password_hash, deleted_at FROM users WHERE id = $1`, [IDS.owner])).rows[0];
    expect(u.email).toBe(`purged-${IDS.owner}@purged.invalid`);
    expect(u).toMatchObject({ full_name: null, phone: null, status: 'disabled', password_hash: '$argon2id$purged' });
    expect(u.deleted_at).not.toBeNull();
  });

  it('una agencia sin clientes se borra: sus datos de identidad, su personal exclusivo y la lápida', async () => {
    const staff = 'e0000000-0000-4000-8000-0000000000e5';
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,'staff@ag.test',$2,'active',now())`, [staff, HASH]);
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'agency')`, [staff, IDS.agencyOrg]);
    await markDeleted(IDS.agencyOrg, DELETION_B);
    await stepAll(IDS.agencyOrg);
    const r = await identityStep(IDS.agencyOrg);
    expect(r).toMatchObject({ organization_members: 1, organizations_tombstone: 1, users: 1 });
    expect((await admin.query(`SELECT status, kind FROM organizations WHERE id = $1`, [IDS.agencyOrg])).rows[0]).toEqual({ status: 'purged', kind: 'agency' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [staff])).rows[0].n).toBe(0);
  });

  it('es idempotente: tras un corte justo antes de cerrar, ambas funciones se pueden repetir sin error ni borrar más (mientras la eliminación siga «purging»)', async () => {
    await seedOrg(ORG_A, 'A');
    await markDeleted(ORG_A, DELETION_A);
    await stepAll(ORG_A);
    await identityStep(ORG_A); // la empresa ya es una lápida (status purged) pero la eliminación sigue «purging»
    const again = await identityStep(ORG_A);
    expect(Object.entries(again).filter(([k, n]) => k !== 'organizations_tombstone' && n > 0)).toEqual([]);
    const rows = await step(ORG_A);
    expect(rows.every((x) => Number(x.deleted) === 0 && Number(x.remaining) === 0)).toBe(true);
  });

  it('una lápida cuya eliminación YA cerró («purged») no vuelve a abrirse: ambas funciones se niegan', async () => {
    await seedOrg(ORG_A, 'A');
    await markDeleted(ORG_A, DELETION_A);
    await stepAll(ORG_A);
    await identityStep(ORG_A);
    await admin.query(`UPDATE organization_deletions SET state = 'purged', purged_at = now() WHERE id = $1`, [DELETION_A]);
    await expect(step(ORG_A)).rejects.toThrow(/no está eliminada/);
    await expect(identityStep(ORG_A)).rejects.toThrow(/no está en borrado definitivo/);
  });

  it('el dato de otra empresa jamás se ve afectado aunque se llame con la empresa equivocada (B viva): se niega', async () => {
    await seedOrg(ORG_A, 'A');
    await seedOrg(ORG_B, 'B');
    const beforeB = await fingerprint(ORG_B);
    await markDeleted(ORG_A, DELETION_A);
    await expect(step(ORG_B)).rejects.toThrow(/no está eliminada/);
    expect(await fingerprint(ORG_B)).toEqual(beforeB);
  });
});
