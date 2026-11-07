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
// M3.3 §11 (aprobado el 2026-11-07): canal del lead
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const channelOfContact = async (id: string): Promise<string> => (await admin.query('SELECT channel FROM contacts WHERE id = $1', [id])).rows[0].channel as string;
const ingest = (m: NormalizedMessage) => TenantContext.run({ organizationId: ORG_A }, () => import('../../src/db').then(({ Database }) => app.get(Database).withTenant((tx) => conversations.ingestInbound(tx, channelA, m, { now: new Date(), timeZone: 'America/Guayaquil', assignable: new Set() }))));

describe('canal del lead (M3.3 §11)', () => {
  it('un clic CTWA crea el contacto con channel=facebook (sin placement o con placement facebook) o instagram', async () => {
    await record(click({ phone: '+593984100001', ctwa_cl_id: 'c-ig', placement: 'instagram' }));
    await record(click({ phone: '+593984100002', ctwa_cl_id: 'c-fb', placement: 'facebook' }));
    await record(click({ phone: '+593984100003', ctwa_cl_id: 'c-none' }));
    expect(await channelOfContact(await contactOf('+593984100001'))).toBe('instagram');
    expect(await channelOfContact(await contactOf('+593984100002'))).toBe('facebook');
    expect(await channelOfContact(await contactOf('+593984100003'))).toBe('facebook'); // sin placement: el valor por omisión de un anuncio de Meta
  });

  it('un mensaje de WhatsApp sin anuncio crea el contacto como whatsapp; con el aviso de un anuncio (referral), como facebook', async () => {
    const msg = (over: Partial<NormalizedMessage> & { externalId: string; from: string }): NormalizedMessage => ({ fromRaw: over.from.slice(1), profileName: 'Ana', kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date('2026-10-15T15:00:00Z'), ...over });
    await ingest(msg({ externalId: 'wamid.CH1', from: '+593984100004' }));
    await ingest(msg({ externalId: 'wamid.CH2', from: '+593984100005', referral: { sourceId: '120077', sourceType: 'ad', sourceUrl: null, headline: 'Promo', body: null, thumbnailUrl: null, ctwaClid: 'clid-ch2' } }));
    expect(await channelOfContact(await contactOf('+593984100004'))).toBe('whatsapp');
    expect(await channelOfContact(await contactOf('+593984100005'))).toBe('facebook');
  });

  it('la creación manual deja channel=manual por omisión y acepta uno de los permitidos; el origen sigue siendo «manual»', async () => {
    const a = await json<{ id: string; channel: string; source: string }>(await call('POST', '/contacts', T.alice, { name: 'Beto', phones: ['+593984100006'] }));
    expect(a).toMatchObject({ channel: 'manual', source: 'manual' });
    const b = await json<{ id: string; channel: string }>(await call('POST', '/contacts', T.alice, { name: 'Carla', phones: ['+593984100007'], channel: 'instagram' }));
    expect(b.channel).toBe('instagram');
    expect(await channelOfContact(b.id)).toBe('instagram');
    // el asesor también puede crear con un canal permitido; uno que no lo es, 400
    expect((await call('POST', '/contacts', T.carol, { name: 'Dani', phones: ['+593984100008'], channel: 'whatsapp' })).status).toBe(201);
    for (const bad of ['tiktok', 'Facebook', '', null, 5]) expect((await call('POST', '/contacts', T.alice, { name: 'X', phones: ['+593984100009'], channel: bad })).status, String(bad)).toBe(400);
    // la auditoría de la creación lo registra
    const audit = (await admin.query("SELECT new_value FROM audit_logs WHERE entity_type = 'contact' AND entity_id = $1 AND field IS NULL", [b.id])).rows[0];
    expect(audit.new_value).toMatchObject({ channel: 'instagram', source: 'manual' });
  });

  it('el canal es de solo lectura tras crear el contacto: el PATCH lo rechaza y no cambia nada', async () => {
    const made = await json<{ id: string }>(await call('POST', '/contacts', T.alice, { name: 'Eva', phones: ['+593984100012'], channel: 'whatsapp' }));
    expect((await call('PATCH', `/contacts/${made.id}`, T.alice, { channel: 'facebook' })).status).toBe(400);
    expect((await call('PATCH', `/contacts/${made.id}`, T.alice, { name: 'Eva Luna', channel: 'facebook' })).status).toBe(400);
    expect(await channelOfContact(made.id)).toBe('whatsapp');
    expect((await call('PATCH', `/contacts/${made.id}`, T.alice, { name: 'Eva Luna' })).status).toBe(200); // lo demás se sigue editando
    expect(await channelOfContact(made.id)).toBe('whatsapp');
  });

  it('GET /contacts y GET /contacts/:id traen el canal (también dentro de la atribución)', async () => {
    await record(click({ phone: '+593984100010', ctwa_cl_id: 'c-list', placement: 'instagram' }));
    const id = await contactOf('+593984100010');
    const one = await json<{ channel: string; attribution: { channel: string } | null }>(await call('GET', `/contacts/${id}`, T.alice));
    expect(one.channel).toBe('instagram');
    expect(one.attribution?.channel).toBe('instagram');
    const list = await json<{ items: Array<{ id: string; channel: string }> }>(await call('GET', '/contacts', T.alice));
    expect(list.items.find((x) => x.id === id)?.channel).toBe('instagram');
  });

  it('una vez asignado, el canal NUNCA cambia: ni con otro clic (otro placement), ni con otro mensaje', async () => {
    await record(click({ phone: '+593984100011', ctwa_cl_id: 'first', placement: 'instagram' }));
    await record(click({ phone: '+593984100011', ctwa_cl_id: 'second', placement: 'facebook' }));
    await record(click({ phone: '+593984100011', ctwa_cl_id: 'third' }));
    const id = await contactOf('+593984100011');
    await ingest({ externalId: 'wamid.LATE', from: '+593984100011', fromRaw: '593984100011', profileName: 'Ana', kind: 'text', text: 'Hola otra vez', media: null, extra: {}, sentAt: new Date('2026-10-16T15:00:00Z') } as NormalizedMessage);
    expect(await channelOfContact(id)).toBe('instagram');
  });

  it('el webhook rechaza un placement desconocido (esquema estricto)', async () => {
    const { ctwaWebhookSchema } = await import('../../src/modules/attribution/attribution.dto');
    expect(ctwaWebhookSchema.safeParse({ phone: '+593984100013', ctwa_cl_id: 'x', placement: 'instagram' }).success).toBe(true);
    expect(ctwaWebhookSchema.safeParse({ phone: '+593984100013', ctwa_cl_id: 'x', placement: 'tiktok' }).success).toBe(false);
  });

  it('A↔B: el canal no se filtra entre organizaciones (404 uniforme, y la lista de B no trae contactos de A)', async () => {
    const a = await json<{ id: string }>(await call('POST', '/contacts', T.alice, { name: 'De A', phones: ['+593984100020'], channel: 'instagram' }));
    const b = await json<{ id: string; channel: string }>(await call('POST', '/contacts', T.bob, { name: 'De B', phones: ['+593984100021'] }));
    expect(b.channel).toBe('manual');
    expect((await call('GET', `/contacts/${a.id}`, T.bob)).status).toBe(404);
    expect((await call('GET', `/contacts/${b.id}`, T.alice)).status).toBe(404);
    const listB = await json<{ items: Array<{ id: string; channel: string }> }>(await call('GET', '/contacts', T.bob));
    expect(listB.items.map((x) => x.id)).toEqual([b.id]);
    expect(JSON.stringify(listB)).not.toContain('instagram');
    // un clic de A no toca el canal de un contacto de B con el mismo teléfono
    await TenantContext.run({ organizationId: ORG_A }, () => attribution.record(click({ phone: '+593984100021', ctwa_cl_id: 'cross' }) as never));
    expect(await channelOfContact(b.id)).toBe('manual');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// M3.3 §12 (aprobado el 2026-11-07): rendimiento de anuncios
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
type AdRow = { ad_id: string; ad_name: string | null; campaign_name: string | null; adset_name: string | null; leads: number; appointments: number; sales: number; revenue: string };
type AdPerf = { rows: AdRow[]; period: { from: string; to: string } };
const perf = (t: string | undefined, qs = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`) => call('GET', `/attribution/ad-performance?${qs}`, t);

describe('rendimiento de anuncios (M3.3 §12)', () => {
  it('por anuncio: leads (primer toque), citas no canceladas, ventas activas e ingresos; ordenado por ventas y luego ingresos', async () => {
    // Anuncio 1: 3 leads, 2 citas (una cancelada no cuenta), 2 ventas activas (una anulada no cuenta) por 30 + 45.50
    const a1 = await lead({ first: { ad: 'Corte promo', adId: '120001', campaign: 'Octubre', at: '2026-10-05T15:00:00Z' } });
    const a2 = await lead({ first: { ad: 'Corte promo', adId: '120001', campaign: 'Octubre', at: '2026-10-06T15:00:00Z' } });
    await lead({ first: { ad: 'Corte promo', adId: '120001', campaign: 'Octubre', at: '2026-10-07T15:00:00Z' } });
    await appointment(a1, '2026-10-10T15:00:00Z');
    await appointment(a1, '2026-10-11T15:00:00Z');
    await appointment(a2, '2026-10-12T15:00:00Z', 'cancelled');
    await sale(a1, '2026-10-10T16:00:00Z', 30);
    await sale(a2, '2026-10-12T16:00:00Z', 45.5);
    await sale(a2, '2026-10-13T16:00:00Z', 99, 'cancelled');
    // Anuncio 2: 1 lead y 2 ventas por 100 (más ventas): va primero
    const b1 = await lead({ first: { ad: 'Tinte', adId: '120002', campaign: 'Noviembre', at: '2026-10-08T15:00:00Z' } });
    await sale(b1, '2026-10-09T16:00:00Z', 40);
    await sale(b1, '2026-10-10T16:00:00Z', 60);
    // Anuncio 3: 2 ventas pero menos ingresos que el 1: desempata por ingresos
    const c1 = await lead({ first: { ad: 'Barba', adId: '120003', campaign: 'Octubre', at: '2026-10-09T15:00:00Z' } });
    await sale(c1, '2026-10-10T16:00:00Z', 10);
    await sale(c1, '2026-10-11T16:00:00Z', 10);
    // Anuncio 4: sin ventas
    await lead({ first: { ad: 'Cejas', adId: '120004', campaign: 'Octubre', at: '2026-10-09T15:00:00Z' } });
    await admin.query("UPDATE contacts SET first_touch_adset = 'Conjunto A' WHERE first_touch_ad_id = '120001'");

    const r = await json<AdPerf>(await perf(T.alice));
    expect(r.rows.map((x) => [x.ad_id, x.leads, x.appointments, x.sales, x.revenue])).toEqual([
      ['120002', 1, 0, 2, '100.00'], // 2 ventas, 100
      ['120001', 3, 2, 2, '75.50'], // 2 ventas, 75.50 (la anulada y la cita cancelada no cuentan)
      ['120003', 1, 0, 2, '20.00'],
      ['120004', 1, 0, 0, '0.00'],
    ]);
    expect(r.rows[1]).toMatchObject({ ad_name: 'Corte promo', campaign_name: 'Octubre', adset_name: 'Conjunto A' });
    expect(r.period).toEqual({ from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() });
  });

  it('solo cuentan los contactos vigentes, con id de anuncio y cuyo primer toque cae en el periodo; el nombre es el del contacto más reciente', async () => {
    await lead({ first: { ad: 'Nombre viejo', adId: '120001', at: '2026-10-05T15:00:00Z' } });
    await lead({ first: { ad: 'Nombre nuevo', adId: '120001', at: '2026-10-20T15:00:00Z' } });
    await lead({ first: { ad: 'Fuera de periodo', adId: '120005', at: '2026-08-01T15:00:00Z' } });
    await lead({ first: { ad: 'Sin id', adId: null, at: '2026-10-05T15:00:00Z' } });
    await lead({ first: null });
    const gone = await lead({ first: { ad: 'Nombre nuevo', adId: '120001', at: '2026-10-21T15:00:00Z' } });
    await admin.query('UPDATE contacts SET deleted_at = now() WHERE id = $1', [gone]);
    const r = await json<AdPerf>(await perf(T.alice));
    expect(r.rows.map((x) => [x.ad_id, x.ad_name, x.leads])).toEqual([['120001', 'Nombre nuevo', 2]]);
  });

  it('from y to aceptan fecha o fecha con hora; por omisión, los últimos 30 días; "to" con fecha es inclusivo', async () => {
    await lead({ first: { ad: 'Reciente', adId: '120006', at: new Date(Date.now() - 5 * 86_400_000).toISOString() } });
    await lead({ first: { ad: 'Antiguo', adId: '120007', at: new Date(Date.now() - 45 * 86_400_000).toISOString() } });
    const def = await json<AdPerf>(await perf(T.alice, ''));
    expect(def.rows.map((x) => x.ad_id)).toEqual(['120006']);
    expect(new Date(def.period.to).getTime() - new Date(def.period.from).getTime()).toBe(30 * 86_400_000);
    await lead({ first: { ad: 'Último día', adId: '120008', at: '2026-10-31T23:00:00Z' } });
    const byDate = await json<AdPerf>(await perf(T.alice, 'from=2026-10-01&to=2026-10-31'));
    expect(byDate.rows.map((x) => x.ad_id)).toEqual(['120008']); // "to" de solo fecha incluye todo ese día
    expect(byDate.period).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
  });

  it('valida los parámetros: fechas inválidas o al revés, periodo demasiado largo y parámetros desconocidos son 400', async () => {
    for (const qs of ['from=ayer', 'to=2026-13-40', 'from=2026-11-01&to=2026-10-01', 'from=2020-01-01&to=2026-01-01', 'channel=facebook', 'touchModel=first']) expect((await perf(T.alice, qs)).status, qs).toBe(400);
  });

  it('permisos: el asesor recibe 403 y sin sesión 401', async () => {
    await lead({ first: { ad: 'A', adId: '120001', at: '2026-10-05T15:00:00Z' } });
    expect((await perf(T.carol)).status).toBe(403);
    expect((await perf(undefined)).status).toBe(401);
    expect((await perf(T.alice)).status).toBe(200);
  });

  it('A↔B: cada empresa ve solo sus anuncios, aunque compartan el mismo id de anuncio; las ventas de A no suman en B', async () => {
    const a = await lead({ first: { ad: 'Anuncio compartido', adId: '120001', at: '2026-10-05T15:00:00Z' } });
    await lead({ first: { ad: 'Anuncio compartido', adId: '120001', at: '2026-10-06T15:00:00Z' } });
    await lead({ first: { ad: 'Solo de A', adId: '120009', at: '2026-10-06T15:00:00Z' } });
    await sale(a, '2026-10-07T16:00:00Z', 80);
    await lead({ org: ORG_B, first: { ad: 'Anuncio compartido', adId: '120001', at: '2026-10-05T15:00:00Z' } });
    await lead({ org: ORG_B, first: { ad: 'Solo de B', adId: '120010', at: '2026-10-05T15:00:00Z' } });
    const ra = await json<AdPerf>(await perf(T.alice));
    const rb = await json<AdPerf>(await perf(T.bob));
    expect(ra.rows.map((x) => [x.ad_id, x.leads, x.sales, x.revenue])).toEqual([['120001', 2, 1, '80.00'], ['120009', 1, 0, '0.00']]);
    expect(rb.rows.map((x) => [x.ad_id, x.leads, x.sales, x.revenue])).toEqual([['120001', 1, 0, '0.00'], ['120010', 1, 0, '0.00']]);
    expect(JSON.stringify(rb)).not.toContain('Solo de A');
    expect(JSON.stringify(ra)).not.toContain('Solo de B');
  });
});
