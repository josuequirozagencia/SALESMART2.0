// M6.6 — Historial de toques y «Anuncio ganador» (ADR-55, fase A). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/contacts/:id/touches
//   GET /v1/analytics/winning-ads
//   GET /v1/attribution/ad-performance
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AnalyticsModule } from '../../src/modules/analytics';
import { AttributionModule, AttributionService } from '../../src/modules/attribution';
import { referralOf } from '../../src/modules/channels/meta-webhook';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule, cleanUrl } from '../../src/modules/contacts';
import { ConversationsModule, ConversationsService, type NormalizedMessage } from '../../src/modules/conversations';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, AttributionModule.register(), ConversationsModule, AnalyticsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const FROM = '2026-10-01T05:00:00.000Z';
const TO = '2026-11-01T05:00:00.000Z';
const q = (mode?: string) => `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}${mode ? `&mode=${mode}` : ''}`;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let attribution: AttributionService;
let conversations: ConversationsService;
let T: Record<'alice' | 'carol' | 'bob', string>;
let queueA = '';
let productA = '';
let channelA = '';
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE contact_touch_events, meta_events, sale_payments, sales, appointment_reminders, appointments, response_timers, messages, conversation_participants, conversations, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queue_products, queues, contact_tags, tags, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, member_permissions, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
  queueA = (await admin.query(`INSERT INTO queues(organization_id, id, name) VALUES ($1, gen_random_uuid(), 'Ventas') RETURNING id`, [ORG_A])).rows[0].id as string;
  productA = (await admin.query(`INSERT INTO queue_products(organization_id, id, queue_id, name, price) VALUES ($1, gen_random_uuid(), $2, 'Corte', 10) RETURNING id`, [ORG_A, queueA])).rows[0].id as string;
  channelA = (await admin.query(`INSERT INTO channel_accounts(organization_id, id, provider, name) VALUES ($1, gen_random_uuid(), 'meta_cloud', 'Ventas') RETURNING id`, [ORG_A])).rows[0].id as string;
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

let seq = 0;
interface Touch { ad?: string | null; adId?: string | null; campaign?: string | null; at: string }
/** Un contacto con su primer toque ya grabado (como lo deja el clic). */
async function lead(o: { org?: string; owner?: string | null; first?: Touch | null; name?: string }): Promise<string> {
  seq += 1;
  const f = o.first;
  return (
    await admin.query(
      `INSERT INTO contacts(id, organization_id, name, owner_id, first_touch_at, first_touch_source, first_touch_ad, first_touch_ad_id, first_touch_campaign) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [o.org ?? ORG_A, o.name ?? `Cliente ${seq}`, o.owner ?? null, f?.at ?? null, f ? 'meta_ctwa' : null, f?.ad ?? null, f?.adId ?? null, f?.campaign ?? null],
    )
  ).rows[0].id as string;
}
async function sale(contact: string, at: string, amount: number, status: 'active' | 'cancelled' = 'active'): Promise<void> {
  seq += 1;
  await admin.query(
    `INSERT INTO sales(organization_id, id, contact_id, queue_id, product_id, product_name, product_kind, quantity, amount, currency, status, seller_id, idempotency_key, created_by, created_at, cancelled_at, cancelled_by, cancel_reason)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, 'Corte', 'service', 1, $5, 'USD', $6, $7, $8, $7, $9, $10, $11, $12)`,
    [ORG_A, contact, queueA, productA, amount, status, IDS.alice, `key-${seq}-${Math.random()}`.padEnd(10, 'x'), at, status === 'cancelled' ? at : null, status === 'cancelled' ? IDS.alice : null, status === 'cancelled' ? 'prueba' : null],
  );
}
async function appointment(contact: string, createdAt: string, status = 'scheduled'): Promise<void> {
  seq += 1;
  await admin.query(`INSERT INTO appointments(organization_id, id, contact_id, owner_id, starts_at, status, idempotency_key, created_by, created_at, cancelled_at, cancelled_by, cancel_reason) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $3, $7, $8, $9, $10)`,
    [ORG_A, contact, IDS.alice, createdAt, status, `ap-${seq}-${Math.random()}`.padEnd(10, 'x'), createdAt, status === 'cancelled' ? createdAt : null, status === 'cancelled' ? IDS.alice : null, status === 'cancelled' ? 'prueba' : null]);
}
const click = (over: Record<string, unknown> = {}) => ({ phone: '+593984217701', ctwa_cl_id: 'clid-1', source: 'meta_ctwa', ad_id: '120001', ad_name: 'Corte promo', campaign_name: 'Octubre', headline: 'Corte 2x1', thumbnail_url: 'https://cdn.meta.test/a.jpg', ...over });
const record = (input: ReturnType<typeof click>, at?: Date) => TenantContext.run({ organizationId: ORG_A }, () => attribution.record(input as never, at));
const touches = async (t: string, id: string) => json<{ items: Array<{ kind: string; ad_id: string | null; ad: string | null; headline: string | null; thumbnail_url: string | null; source_url: string | null; utm: Record<string, string>; at: string }> }>(await call('GET', `/contacts/${id}/touches`, t));
const winning = async (t: string, mode?: string) => json<{ rows: Array<{ ad: string; ad_id: string | null; chats: number; appointments: number; sales: number; revenue: string; close_rate: string; thumbnail_url: string | null }>; totals: Record<string, string | number>; title: string }>(await call('GET', `/analytics/winning-ads?${q(mode)}`, t));
const contactOf = async (phone: string): Promise<string> => (await admin.query(`SELECT contact_id FROM contact_phones WHERE e164 = $1 AND organization_id = $2`, [phone, ORG_A])).rows[0].contact_id as string;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'CAPI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', CAPI_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  attribution = app.get(AttributionService);
  conversations = app.get(ConversationsService);
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
});

describe('el aviso de Meta y las direcciones (funciones puras)', () => {
  it('referralOf toma solo lo conocido y acotado; sin nada útil es null', () => {
    expect(referralOf({ source_id: '120001', source_type: 'ad', headline: 'Corte 2x1', ctwa_clid: 'abc', thumbnail_url: 'https://x.test/a.jpg', extra: 'se ignora' })).toEqual({ sourceId: '120001', sourceType: 'ad', sourceUrl: null, headline: 'Corte 2x1', body: null, thumbnailUrl: 'https://x.test/a.jpg', ctwaClid: 'abc' });
    expect(referralOf({ headline: 'x'.repeat(900) })!.headline).toHaveLength(300);
    expect(referralOf({})).toBeNull();
    expect(referralOf(null)).toBeNull();
    expect(referralOf('texto')).toBeNull();
    expect(referralOf([1])).toBeNull();
  });
  it('cleanUrl solo acepta https sin usuario ni contraseña', () => {
    expect(cleanUrl('https://cdn.meta.test/a.jpg')).toBe('https://cdn.meta.test/a.jpg');
    for (const bad of ['http://x.test/a', 'javascript:alert(1)', 'https://u:p@x.test/', 'no es url', '', 'https://x.test/' + 'a'.repeat(1100)]) expect(cleanUrl(bad), bad).toBeNull();
  });
});

describe('historial de toques', () => {
  it('un clic graba el primer y el último toque con el id del anuncio y una fila en el historial; repetir el mismo clic no duplica nada', async () => {
    const r = await record(click());
    expect(r).toMatchObject({ contactCreated: true, duplicate: false });
    const id = await contactOf('+593984217701');
    const c = (await admin.query(`SELECT first_touch_ad_id, last_touch_ad_id, first_touch_ad FROM contacts WHERE id = $1`, [id])).rows[0];
    expect(c).toEqual({ first_touch_ad_id: '120001', last_touch_ad_id: '120001', first_touch_ad: 'Corte promo' });
    expect(await record(click())).toMatchObject({ duplicate: true });
    expect(Number((await admin.query(`SELECT count(*) FROM contact_touch_events WHERE contact_id = $1`, [id])).rows[0].count)).toBe(1);
    const t = await touches(T.alice, id);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: 'ad_click', ad_id: '120001', ad: 'Corte promo', headline: 'Corte 2x1', thumbnail_url: 'https://cdn.meta.test/a.jpg' });
  });

  it('un segundo clic de OTRO anuncio: el primer toque no cambia, el último sí, y el historial trae los dos del más reciente al más antiguo', async () => {
    await record(click(), new Date('2026-10-10T10:00:00Z'));
    await record(click({ ctwa_cl_id: 'clid-2', ad_id: '120002', ad_name: 'Barba', occurred_at: '2026-10-12T10:00:00Z' }));
    const id = await contactOf('+593984217701');
    expect((await admin.query(`SELECT first_touch_ad_id, last_touch_ad_id FROM contacts WHERE id = $1`, [id])).rows[0]).toEqual({ first_touch_ad_id: '120001', last_touch_ad_id: '120002' });
    expect((await touches(T.alice, id)).items.map((x) => x.ad_id)).toEqual(['120002', '120001']);
  });

  it('las direcciones que no son https no se guardan; el nombre del anuncio puede repetirse con ids distintos', async () => {
    await record(click({ thumbnail_url: 'http://inseguro.test/a.jpg', source_url: 'javascript:alert(1)' }));
    const id = await contactOf('+593984217701');
    const t = (await touches(T.alice, id)).items[0]!;
    expect(t.thumbnail_url).toBeNull();
    expect(t.source_url).toBeNull();
  });

  it('el primer mensaje de alguien nuevo es un toque «message_in» y uno que llegó por un clic a un anuncio es un «ad_click» con su anuncio (aviso de Meta)', async () => {
    const msg = (over: Partial<NormalizedMessage> & { externalId: string; from: string }): NormalizedMessage => ({ fromRaw: over.from.slice(1), profileName: 'Ana', kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date('2026-10-15T15:00:00Z'), ...over });
    const run = (m: NormalizedMessage) => TenantContext.run({ organizationId: ORG_A }, () => import('../../src/db').then(({ Database }) => app.get(Database).withTenant((tx) => conversations.ingestInbound(tx, channelA, m, { now: new Date(), timeZone: 'America/Guayaquil', assignable: new Set() }))));
    await run(msg({ externalId: 'wamid.A1', from: '+593984000001' }));
    await run(msg({ externalId: 'wamid.A2', from: '+593984000001', text: 'Otra vez' })); // el mismo contacto, ya no es nuevo
    await run(msg({ externalId: 'wamid.B1', from: '+593984000002', referral: { sourceId: '120009', sourceType: 'ad', sourceUrl: null, headline: 'Promo de octubre', body: null, thumbnailUrl: 'https://cdn.meta.test/b.jpg', ctwaClid: 'clid-b' } }));
    const a = await contactOf('+593984000001');
    const b = await contactOf('+593984000002');
    expect((await touches(T.alice, a)).items.map((x) => x.kind)).toEqual(['message_in']);
    const tb = (await touches(T.alice, b)).items;
    expect(tb).toHaveLength(1);
    expect(tb[0]).toMatchObject({ kind: 'ad_click', ad_id: '120009', headline: 'Promo de octubre' });
    expect((await admin.query(`SELECT first_touch_ad_id FROM contacts WHERE id = $1`, [b])).rows[0].first_touch_ad_id).toBe('120009');
    expect(Number((await admin.query(`SELECT count(*) FROM meta_events WHERE contact_id = $1 AND type = 'Lead'`, [b])).rows[0].count)).toBe(1); // el clic de anuncio deja su Lead hacia Meta
    expect(Number((await admin.query(`SELECT count(*) FROM meta_events WHERE contact_id = $1`, [a])).rows[0].count)).toBe(0); // un mensaje común no
  });

  it('el alcance por persona: el asesor ve solo los toques de SUS contactos (404 uniforme en los demás); la otra empresa nunca; sin sesión 401', async () => {
    const mine = await lead({ owner: IDS.carol, first: { at: '2026-10-05T10:00:00Z', adId: '1' } });
    const other = await lead({ owner: IDS.alice, first: { at: '2026-10-05T10:00:00Z', adId: '1' } });
    const bobs = await lead({ org: ORG_B, owner: IDS.bob, first: { at: '2026-10-05T10:00:00Z', adId: '1' } });
    expect((await call('GET', `/contacts/${mine}/touches`, T.carol)).status).toBe(200);
    expect((await call('GET', `/contacts/${other}/touches`, T.carol)).status).toBe(404);
    expect((await call('GET', `/contacts/${other}/touches`, T.alice)).status).toBe(200);
    expect((await call('GET', `/contacts/${bobs}/touches`, T.alice)).status).toBe(404);
    expect((await call('GET', `/contacts/${mine}/touches`, T.bob)).status).toBe(404);
    expect((await call('GET', `/contacts/${mine}/touches`)).status).toBe(401);
    expect((await call('GET', `/contacts/no-es-uuid/touches`, T.alice)).status).toBe(400);
  });

  it('la tabla es de solo inserción: app_rw no puede modificar ni borrar el pasado', async () => {
    await record(click());
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      await rw.query(`SELECT set_config('app.org_id', $1, false)`, [ORG_A]);
      await expect(rw.query(`UPDATE contact_touch_events SET source = 'otro'`)).rejects.toThrow(/permission denied/i);
      await expect(rw.query(`DELETE FROM contact_touch_events`)).rejects.toThrow(/permission denied/i);
    } finally {
      await rw.end();
    }
  });
});

describe('«Anuncio ganador»', () => {
  /** Dos anuncios: A (3 chats: 2 compran, una venta llega en noviembre) y B (2 chats: ninguno compra, 1 cita). Un chat de septiembre de A compra en octubre. */
  async function world(): Promise<void> {
    const a1 = await lead({ owner: IDS.carol, first: { at: '2026-10-05T10:00:00Z', adId: 'AD-A', ad: 'Corte promo', campaign: 'Octubre' } });
    const a2 = await lead({ owner: IDS.carol, first: { at: '2026-10-06T10:00:00Z', adId: 'AD-A', ad: 'Corte promo (renombrado)', campaign: 'Octubre' } });
    const a3 = await lead({ owner: IDS.alice, first: { at: '2026-10-20T10:00:00Z', adId: 'AD-A', ad: 'Corte promo', campaign: 'Octubre' } });
    const aOld = await lead({ owner: IDS.carol, first: { at: '2026-09-20T10:00:00Z', adId: 'AD-A', ad: 'Corte promo', campaign: 'Septiembre' } });
    const b1 = await lead({ owner: IDS.carol, first: { at: '2026-10-07T10:00:00Z', adId: 'AD-B', ad: 'Barba', campaign: 'Octubre' } });
    const b2 = await lead({ owner: IDS.alice, first: { at: '2026-10-08T10:00:00Z', adId: 'AD-B', ad: 'Barba', campaign: 'Octubre' } });
    await lead({ owner: IDS.carol, first: null, name: 'Orgánico' });
    await sale(a1, '2026-10-10T12:00:00Z', 30);
    await sale(a2, '2026-11-15T12:00:00Z', 40); // la venta llega DESPUÉS del periodo
    await sale(a3, '2026-10-25T12:00:00Z', 50, 'cancelled'); // anulada: no cuenta
    await sale(aOld, '2026-10-12T12:00:00Z', 70); // llegó en septiembre, compra en octubre
    await appointment(a1, '2026-10-09T12:00:00Z');
    await appointment(b1, '2026-10-09T12:00:00Z');
    await appointment(b2, '2026-10-10T12:00:00Z', 'cancelled'); // cancelada: no cuenta
  }

  it('COHORTE (por omisión): los que llegaron en el periodo y cuántos ya compraron; una venta tardía suma a su anuncio original y una de septiembre no entra', async () => {
    await world();
    const r = await winning(T.alice);
    expect(r.title).toMatch(/fecha de llegada/);
    expect(r.rows.map((x) => [x.ad_id, x.chats, x.appointments, x.sales, x.revenue, x.close_rate])).toEqual([
      ['AD-A', 3, 1, 2, '70.00', '66.7 %'], // ventas de a1 (30) y a2 (40, tardía); a3 anulada
      ['AD-B', 2, 1, 0, '0.00', '0.0 %'],
    ]);
    expect(r.totals).toEqual({ chats: 5, appointments: 2, sales: 2, revenue: '70.00' });
  });

  it('POR FECHA DE CONVERSIÓN: las ventas y citas que OCURRIERON en el periodo, sea cual sea su fecha de llegada', async () => {
    await world();
    const r = await winning(T.alice, 'conversion');
    expect(r.title).toMatch(/fecha de conversión/);
    expect(r.rows.map((x) => [x.ad_id, x.chats, x.appointments, x.sales, x.revenue])).toEqual([
      ['AD-A', 3, 1, 2, '100.00'], // a1 (30, oct) + la de septiembre que compró en octubre (70); la de noviembre queda fuera
      ['AD-B', 2, 1, 0, '0.00'],
    ]);
  });

  it('el mismo id con otro nombre es UN solo anuncio (el nombre cambió); sin id se agrupa por nombre; sin datos del anuncio va aparte', async () => {
    await lead({ owner: IDS.alice, first: { at: '2026-10-05T10:00:00Z', adId: 'AD-X', ad: 'Nombre viejo' } });
    await lead({ owner: IDS.alice, first: { at: '2026-10-06T10:00:00Z', adId: 'AD-X', ad: 'Nombre nuevo' } });
    await lead({ owner: IDS.alice, first: { at: '2026-10-07T10:00:00Z', ad: 'Solo nombre' } });
    await lead({ owner: IDS.alice, first: { at: '2026-10-08T10:00:00Z', ad: 'Solo nombre' } });
    await lead({ owner: IDS.alice, first: { at: '2026-10-09T10:00:00Z' } });
    const r = await winning(T.alice);
    expect(r.rows.map((x) => [x.ad_id ?? x.ad, x.chats]).sort()).toEqual([['AD-X', 2], ['Solo nombre', 2], ['Sin datos del anuncio', 1]].sort());
  });

  it('muestra el titular y la miniatura del clic cuando Meta los entregó', async () => {
    await record(click({ occurred_at: '2026-10-10T10:00:00Z' }));
    const id = await contactOf('+593984217701');
    await admin.query(`UPDATE contacts SET owner_id = $1 WHERE id = $2`, [IDS.alice, id]);
    const r = await winning(T.alice);
    expect(r.rows[0]).toMatchObject({ ad_id: '120001', thumbnail_url: 'https://cdn.meta.test/a.jpg' });
  });

  it('alcance por persona: el asesor ve solo los anuncios de SUS contactos; otra empresa no se mezcla; sin sesión 401', async () => {
    await world();
    await lead({ org: ORG_B, owner: IDS.bob, first: { at: '2026-10-05T10:00:00Z', adId: 'AD-B-LUNA', ad: 'De Luna' } });
    const carol = await winning(T.carol);
    expect(carol.rows.map((x) => [x.ad_id, x.chats])).toEqual([['AD-A', 2], ['AD-B', 1]]); // solo a1, a2 y b1; sin los chats de Alicia (a3 y b2) ni el de septiembre
    const bob = await winning(T.bob);
    expect(bob.rows.map((x) => x.ad_id)).toEqual(['AD-B-LUNA']);
    expect(JSON.stringify(bob)).not.toMatch(/AD-A|Corte promo/);
    expect((await call('GET', `/analytics/winning-ads?${q()}`)).status).toBe(401);
  });

  it('sin datos devuelve la lista vacía con totales en cero; un periodo inválido es 400; el modo debe ser uno de los dos', async () => {
    const r = await winning(T.alice);
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ chats: 0, sales: 0 });
    expect((await call('GET', `/analytics/winning-ads?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`, T.alice)).status).toBe(400);
    expect((await call('GET', `/analytics/winning-ads?${q('otro')}`, T.alice)).status).toBe(400);
  });

  it('el CSV de analítica incluye este reporte en el mismo modo que se ve (la descarga queda registrada)', async () => {
    await world();
    const r = await call('POST', '/analytics/export', T.alice, { report: 'winning_ads', from: FROM, to: TO, mode: 'conversion' });
    expect(r.status).toBe(200);
    const csv = await r.text();
    expect(csv).toContain('Anuncio');
    expect(csv).toContain('Chats nuevos');
    expect(csv).toMatch(/AD-?A|Corte promo/);
    expect(Number((await admin.query(`SELECT count(*) FROM analytics_exports WHERE report = 'winning_ads'`)).rows[0].count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// M3.3 §11 y §12 (aprobados el 2026-11-07): canal del lead y rendimiento de anuncios
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const channelOfContact = async (id: string): Promise<string> => (await admin.query('SELECT channel FROM contacts WHERE id = $1', [id])).rows[0].channel as string;
const ingest = (m: NormalizedMessage) => TenantContext.run({ organizationId: ORG_A }, () => import('../../src/db').then(({ Database }) => app.get(Database).withTenant((tx) => conversations.ingestInbound(tx, channelA, m, { now: new Date(), timeZone: 'America/Guayaquil', assignable: new Set() }))));

describe('canal del lead (M3.3 §11)', () => {
  it('se deriva al crear el contacto: instagram, facebook (con placement y sin él), whatsapp, manual y otro', async () => {
    await record(click({ phone: '+593984100001', ctwa_cl_id: 'c-ig', placement: 'instagram' }));
    await record(click({ phone: '+593984100002', ctwa_cl_id: 'c-fb', placement: 'facebook' }));
    await record(click({ phone: '+593984100003', ctwa_cl_id: 'c-none' }));
    expect(await channelOfContact(await contactOf('+593984100001'))).toBe('instagram');
    expect(await channelOfContact(await contactOf('+593984100002'))).toBe('facebook');
    expect(await channelOfContact(await contactOf('+593984100003'))).toBe('facebook'); // sin placement: el valor por omisión de un anuncio de Meta
    // mensaje de WhatsApp sin anuncio → whatsapp; con aviso de anuncio (referral) → facebook
    const msg = (over: Partial<NormalizedMessage> & { externalId: string; from: string }): NormalizedMessage => ({ fromRaw: over.from.slice(1), profileName: 'Ana', kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date('2026-10-15T15:00:00Z'), ...over });
    await ingest(msg({ externalId: 'wamid.CH1', from: '+593984100004' }));
    await ingest(msg({ externalId: 'wamid.CH2', from: '+593984100005', referral: { sourceId: '120077', sourceType: 'ad', sourceUrl: null, headline: 'Promo', body: null, thumbnailUrl: null, ctwaClid: 'clid-ch2' } }));
    expect(await channelOfContact(await contactOf('+593984100004'))).toBe('whatsapp');
    expect(await channelOfContact(await contactOf('+593984100005'))).toBe('facebook');
    // creado a mano desde la pantalla → manual
    const made = await json<{ id: string; channel: string }>(await call('POST', '/contacts', T.alice, { name: 'Beto', phones: ['+593984100006'] }));
    expect(made.channel).toBe('manual');
    expect(await channelOfContact(made.id)).toBe('manual');
    // otro origen (un formulario, GoHighLevel…) → other
    const { ContactsService } = await import('../../src/modules/contacts');
    const { Database } = await import('../../src/db');
    const other = await TenantContext.run({ organizationId: ORG_A }, () => app.get(Database).withTenant((tx) => app.get(ContactsService).findOrCreateByPhone(tx, '+593984100007', 'form')));
    expect(await channelOfContact(other.id)).toBe('other');
    // y la ficha lo informa (también dentro de la atribución)
    const ig = await json<{ channel: string; attribution: { channel: string } | null }>(await call('GET', `/contacts/${await contactOf('+593984100001')}`, T.alice));
    expect(ig.channel).toBe('instagram');
    expect(ig.attribution?.channel).toBe('instagram');
  });

  it('el canal no cambia con un segundo clic del mismo contacto, ni con otro placement', async () => {
    await record(click({ phone: '+593984100010', ctwa_cl_id: 'first', placement: 'instagram' }));
    await record(click({ phone: '+593984100010', ctwa_cl_id: 'second', placement: 'facebook' }));
    await record(click({ phone: '+593984100010', ctwa_cl_id: 'third' }));
    expect(await channelOfContact(await contactOf('+593984100010'))).toBe('instagram');
  });

  it('el webhook rechaza un placement desconocido (esquema estricto)', async () => {
    const { ctwaWebhookSchema } = await import('../../src/modules/attribution/attribution.dto');
    expect(ctwaWebhookSchema.safeParse({ phone: '+593984100011', ctwa_cl_id: 'x', placement: 'instagram' }).success).toBe(true);
    expect(ctwaWebhookSchema.safeParse({ phone: '+593984100011', ctwa_cl_id: 'x', placement: 'tiktok' }).success).toBe(false);
  });
});

describe('rendimiento de anuncios (M3.3 §12)', () => {
  const tagIds: Record<string, string> = {};
  async function saleTag(org: string): Promise<string> {
    if (!tagIds[org]) tagIds[org] = (await admin.query(`INSERT INTO tags(organization_id, id, name, is_system, system_key) VALUES ($1, gen_random_uuid(), 'Venta', true, 'sale') RETURNING id`, [org])).rows[0].id as string;
    return tagIds[org]!;
  }
  async function adLead(o: { org?: string; ad: string; adset?: string; campaign?: string; channel?: string; at?: string; sold?: boolean; first?: boolean; deleted?: boolean }): Promise<string> {
    seq += 1;
    const org = o.org ?? ORG_A;
    const t = o.first ? 'first_touch' : 'last_touch';
    const id = (
      await admin.query(
        `INSERT INTO contacts(id, organization_id, name, channel, ${t}_at, ${t}_source, ${t}_ad, ${t}_adset, ${t}_campaign, deleted_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'meta_ctwa', $5, $6, $7, $8) RETURNING id`,
        [org, `Cliente ${seq}`, o.channel ?? 'facebook', o.at ?? '2026-10-15T15:00:00Z', o.ad, o.adset ?? 'Conjunto 1', o.campaign ?? 'Campaña 1', o.deleted ? '2026-10-20T00:00:00Z' : null],
      )
    ).rows[0].id as string;
    if (o.sold) await admin.query('INSERT INTO contact_tags(organization_id, contact_id, tag_id, set_by) VALUES ($1, $2, $3, \'system\')', [org, id, await saleTag(org)]);
    return id;
  }
  const perf = (t: string, qs = '') => call('GET', `/attribution/ad-performance?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}${qs}`, t);
  type Perf = { rows: Array<{ adName: string | null; adsetName: string | null; campaignName: string | null; channel: string; leads: number; sales: number; convRate: number; isTopAd: boolean }>; period: { from: string; to: string }; touchModel: string };

  beforeEach(() => { for (const k of Object.keys(tagIds)) delete tagIds[k]; });

  it('agrupa por anuncio, cuenta leads y ventas (etiqueta «Venta»), ordena por ventas y marca solo al primero con al menos una venta', async () => {
    for (let i = 0; i < 4; i++) await adLead({ ad: 'Corte promo', sold: i < 2 });
    for (let i = 0; i < 3; i++) await adLead({ ad: 'Tinte', adset: 'Conjunto 2', campaign: 'Campaña 2', channel: 'instagram', sold: i === 0 });
    await adLead({ ad: 'Barba' });
    await adLead({ ad: 'Corte promo', sold: true, deleted: true }); // un contacto borrado no cuenta
    const r = await json<Perf>(await perf(T.alice));
    expect(r.rows.map((x) => [x.adName, x.leads, x.sales, x.convRate, x.isTopAd])).toEqual([['Corte promo', 4, 2, 50, true], ['Tinte', 3, 1, 33.3, false], ['Barba', 1, 0, 0, false]]);
    expect(r.rows[1]).toMatchObject({ adsetName: 'Conjunto 2', campaignName: 'Campaña 2', channel: 'instagram' });
    expect(r.touchModel).toBe('last');
    expect(r.period).toEqual({ from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() });
  });

  it('sin ninguna venta, ningún anuncio lleva la estrella; en empate de ventas gana el de más leads', async () => {
    await adLead({ ad: 'A' });
    await adLead({ ad: 'B' });
    await adLead({ ad: 'B' });
    let r = await json<Perf>(await perf(T.alice));
    expect(r.rows.every((x) => !x.isTopAd)).toBe(true);
    await adLead({ ad: 'A', sold: true });
    await adLead({ ad: 'B', sold: true });
    r = await json<Perf>(await perf(T.alice));
    expect(r.rows.map((x) => [x.adName, x.sales, x.leads, x.isTopAd])).toEqual([['B', 1, 3, true], ['A', 1, 2, false]]); // empate en ventas: arriba el de más leads
  });

  it('filtra por periodo y por canal; «first» agrupa por el primer toque; valida los parámetros', async () => {
    await adLead({ ad: 'Dentro', at: '2026-10-15T15:00:00Z' });
    await adLead({ ad: 'Fuera', at: '2026-08-01T15:00:00Z' });
    await adLead({ ad: 'IG', channel: 'instagram' });
    await adLead({ ad: 'Primero', first: true });
    expect((await json<Perf>(await perf(T.alice))).rows.map((x) => x.adName).sort()).toEqual(['Dentro', 'IG']);
    expect((await json<Perf>(await perf(T.alice, '&channel=instagram'))).rows.map((x) => x.adName)).toEqual(['IG']);
    expect((await json<Perf>(await perf(T.alice, '&touchModel=first'))).rows.map((x) => x.adName)).toEqual(['Primero']);
    expect((await perf(T.alice, '&channel=tiktok')).status).toBe(400);
    expect((await perf(T.alice, '&touchModel=middle')).status).toBe(400);
    expect((await call('GET', `/attribution/ad-performance?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`, T.alice)).status).toBe(400); // fechas al revés
    expect((await call('GET', '/attribution/ad-performance?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', T.alice)).status).toBe(400); // periodo demasiado largo
    expect((await call('GET', '/attribution/ad-performance?extra=1', T.alice)).status).toBe(400); // parámetros desconocidos
  });

  it('sin parámetros usa los últimos 30 días y la respuesta está lista aunque no haya datos', async () => {
    const r = await json<Perf>(await call('GET', '/attribution/ad-performance', T.alice));
    expect(r.rows).toEqual([]);
    expect(new Date(r.period.to).getTime() - new Date(r.period.from).getTime()).toBe(30 * 86_400_000);
  });

  it('permisos: el asesor recibe 403 y sin sesión 401', async () => {
    await adLead({ ad: 'A', sold: true });
    expect((await perf(T.carol)).status).toBe(403);
    expect((await call('GET', '/attribution/ad-performance')).status).toBe(401);
  });

  it('A↔B: cada empresa ve solo sus anuncios y sus ventas', async () => {
    await adLead({ ad: 'Anuncio de A', sold: true });
    await adLead({ org: ORG_B, ad: 'Anuncio de B', sold: true });
    await adLead({ org: ORG_B, ad: 'Anuncio de B' });
    const a = await json<Perf>(await perf(T.alice));
    const b = await json<Perf>(await perf(T.bob));
    expect(a.rows.map((x) => [x.adName, x.leads, x.sales])).toEqual([['Anuncio de A', 1, 1]]);
    expect(b.rows.map((x) => [x.adName, x.leads, x.sales])).toEqual([['Anuncio de B', 2, 1]]);
  });
});
