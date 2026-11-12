// v11 Pista G · 67b — Citas ↔ Google Calendar (ADR-67). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   POST /v1/calendar/sync/retry
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AppointmentsModule } from '../../src/modules/appointments';
import { AttributionModule } from '../../src/modules/attribution';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { CalendarError, CalendarModule, CalendarSyncService, eventIdOf, FakeCalendarProvider, SYNC_BACKOFF_MS } from '../../src/modules/calendar';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { TemplatesModule } from '../../src/modules/templates';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const gcal = new FakeCalendarProvider();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, OpportunitiesModule, AttributionModule.register(), TemplatesModule, InboxModule, AppointmentsModule, CalendarModule.register({ provider: gcal }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  root: 'd0000000-0000-4000-8000-0000000000d0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, dueña de las conversaciones
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const FRONT = 'https://app.ejemplo.test';
const HOUR = 3_600_000;
const TZ = 'America/Guayaquil';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
let seq = 0;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE appointment_calendar_events, calendar_connections, provider_credentials, provider_selection, platform_audit, appointment_reminders, appointments, message_templates, meta_events, response_timers, messages, conversation_participants, conversations, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, contact_phones, contacts, queue_products, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,$4)`, [id, kind, name, TZ]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', 'Raíz']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

interface Link { id: string; appointment_id: string; event_id: string | null; etag: string | null; calendar_id: string | null; sync_state: string; seq: number; attempts: number; next_attempt_at: Date; last_error: string | null; processing_started_at: Date | null }
const links = async (org = ORG_A): Promise<Link[]> => (await admin.query(`SELECT * FROM appointment_calendar_events WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Link[];
const runSync = (at = new Date(), org = ORG_A): Promise<number> => TenantContext.run({ organizationId: org }, () => app.get(CalendarSyncService).runDue(at));
const kinds = (k: string) => gcal.calls.filter((c) => c.kind === k);
const inH = (h: number): string => new Date(Date.now() + h * HOUR).toISOString();

/** Una conversación de A con su contacto, asignada a la asesora. */
async function mkConv(org = ORG_A, owner: string = IDS.carol): Promise<{ conv: string; contact: string }> {
  seq += 1;
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const channel = (await admin.query(`SELECT id FROM channel_accounts WHERE organization_id = $1 LIMIT 1`, [org])).rows[0].id as string;
  const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, $5) RETURNING id`, [org, contact, channel, owner, phone])).rows[0].id as string;
  return { conv, contact };
}
const mk = async (conv: string, body: Record<string, unknown> = {}, token = T.carol): Promise<{ id: string }> => {
  const r = await call('POST', '/appointments', token, { conversation_id: conv, starts_at: inH(3), kind: 'Corte', ...body }, idem());
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(201);
  return json<{ id: string }>(r);
};

async function configurePlatform(): Promise<void> {
  expect((await call('PUT', '/platform/providers/calendar/google/credentials', T.root, { values: { client_id: 'cliente-de-prueba.example.test', client_secret: 'secreto-de-cliente-de-prueba-0001' } })).status).toBe(200);
  expect((await call('PUT', '/platform/providers/calendar/active', T.root, { provider: 'google' })).status).toBe(200);
}
/** La empresa conecta su calendario (modo propio) por el mismo camino que la persona. */
async function connect(token: string): Promise<void> {
  const r = await call('POST', '/calendar/connection/start', token, { mode: 'own' });
  const state = new URL((await json<{ url: string }>(r)).url).searchParams.get('state')!;
  const back = await fetch(`${base}/integrations/google-calendar/callback?${new URLSearchParams({ code: 'good', state }).toString()}`, { redirect: 'manual' });
  expect(back.headers.get('location')).toBe(`${FRONT}/settings/calendar?calendar=connected`);
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: FRONT, MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY, WHATSAPP_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  for (const [tok] of [[T.alice], [T.bob]] as const) {
    const ch = await call('POST', '/channels', tok, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: tok === T.alice ? '1090123456789' : '1090123456790', access_token: FAKE_WHATSAPP_TOKEN });
    expect(ch.status).toBe(201);
  }
  gcal.calls.length = 0;
  gcal.events.clear();
  gcal.grantedScopes = null;
  gcal.withoutRefreshToken = false;
  gcal.liveRefreshTokens.clear();
  gcal.calendars = [{ id: 'primary-cal', name: 'ana@example.com', primary: true, writable: true }];
  await configurePlatform();
});

describe('Citas → Google Calendar · crear, mover, cancelar, completar', () => {
  it('una cita nueva crea su evento con un id determinista, título «tipo · contacto · asesor», horas en la zona de la empresa y enlace; sin teléfono ni invitados', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv, { starts_at: inH(5), duration_minutes: 45 });
    expect((await links())[0]).toMatchObject({ appointment_id: a.id, sync_state: 'pending', event_id: null, attempts: 0 });
    expect(await runSync()).toBe(1);
    const create = kinds('createEvent')[0]!;
    expect(create.kind === 'createEvent' && create.event).toMatchObject({ id: eventIdOf(a.id), summary: expect.stringMatching(/^Corte · Cliente \d+ · Carolina Vera$/), timeZone: TZ });
    if (create.kind !== 'createEvent') throw new Error('x');
    expect(create.event.endsAt.getTime() - create.event.startsAt.getTime()).toBe(45 * 60_000);
    expect(create.event.description).toContain(`${FRONT}/inbox/${conv}`);
    expect(JSON.stringify(create.event)).not.toMatch(/\+593|@|98700/); // ni teléfono ni correos
    expect(eventIdOf(a.id)).toMatch(/^[0-9a-f]{32}$/); // válido para Google (a-v y 0-9)
    const l = (await links())[0]!;
    expect(l).toMatchObject({ sync_state: 'synced', event_id: eventIdOf(a.id), calendar_id: expect.stringContaining('created-cal'), attempts: 0, last_error: null });
    expect(gcal.events.size).toBe(1);
    expect(await runSync()).toBe(0); // nada más que hacer
  });

  it('reprogramar o cambiar el tipo actualiza el MISMO evento; cancelar lo borra; completar lo deja como historia', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv);
    await runSync();
    const id = eventIdOf(a.id);
    const when = inH(10);
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { starts_at: when, kind: 'Tinte' })).status).toBe(200);
    expect((await links())[0]).toMatchObject({ sync_state: 'pending', seq: 2 });
    await runSync();
    const upd = kinds('updateEvent')[0]!;
    expect(upd.kind === 'updateEvent' && upd.eventId).toBe(id);
    if (upd.kind !== 'updateEvent') throw new Error('x');
    expect(upd.event.summary).toMatch(/^Tinte · /);
    expect(upd.event.startsAt.toISOString()).toBe(when);
    expect(kinds('createEvent')).toHaveLength(1);
    expect(gcal.events.size).toBe(1);

    expect((await call('POST', `/appointments/${a.id}/cancel`, T.carol, { reason: 'El cliente no puede' })).status).toBe(200);
    await runSync();
    expect(kinds('deleteEvent')).toHaveLength(1);
    expect(gcal.events.size).toBe(0);
    expect((await links())[0]).toMatchObject({ sync_state: 'synced', event_id: null });

    const b = await mk(conv);
    await runSync();
    expect(gcal.events.size).toBe(1);
    expect((await call('POST', `/appointments/${b.id}/complete`, T.carol)).status).toBe(200);
    gcal.calls.length = 0;
    await runSync();
    expect(gcal.calls.filter((c) => c.kind === 'createEvent' || c.kind === 'updateEvent' || c.kind === 'deleteEvent')).toHaveLength(0); // completar no toca los eventos de Google
    expect(gcal.events.size).toBe(1);
  });

  it('sin calendario conectado una cita no deja rastro de sincronización; las anteriores a conectar tampoco se envían', async () => {
    const { conv } = await mkConv();
    await mk(conv);
    expect(await links()).toHaveLength(0);
    await connect(T.alice);
    expect(await runSync()).toBe(0);
    expect(gcal.events.size).toBe(0);
    const b = await mk(conv);
    await runSync();
    expect(gcal.events.size).toBe(1);
    expect((await links())[0]!.appointment_id).toBe(b.id);
  });

  it('desconectado, los cambios dejan de anotarse y lo pendiente no sale', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv);
    expect((await call('POST', '/calendar/connection/disconnect', T.alice)).status).toBe(200);
    expect(await runSync()).toBe(0);
    expect(gcal.events.size).toBe(0);
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { kind: 'Otro' })).status).toBe(200);
    expect((await links())[0]).toMatchObject({ sync_state: 'pending', seq: 1 }); // no se volvió a anotar
  });
});

describe('Citas → Google Calendar · robustez', () => {
  it('si el evento ya existe en Google (una pasada murió antes de anotarlo) se actualiza en vez de duplicarse', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv);
    // la pasada anterior creó el evento en Google pero no alcanzó a anotarlo
    const calendar = (await admin.query(`SELECT calendar_id FROM calendar_connections WHERE organization_id = $1`, [ORG_A])).rows[0].calendar_id as string;
    await gcal.createEvent({ accessToken: 'x', calendarId: calendar, event: { id: eventIdOf(a.id), summary: 'viejo', description: '', startsAt: new Date(), endsAt: new Date(), timeZone: TZ } });
    expect(gcal.events.size).toBe(1);
    await runSync();
    expect(gcal.events.size).toBe(1);
    expect(gcal.events.get(`${calendar}/${eventIdOf(a.id)}`)!.summary).toMatch(/^Corte · /);
    expect((await links())[0]).toMatchObject({ sync_state: 'synced', event_id: eventIdOf(a.id) });
  });

  it('un fallo pasajero de Google reintenta con espera creciente y se recupera; el contador vuelve a cero', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    await mk(conv);
    gcal.failNext(new CalendarError('Google no respondió', true), 'createEvent');
    const t0 = new Date();
    expect(await runSync(t0)).toBe(0);
    const l1 = (await links())[0]!;
    expect(l1).toMatchObject({ sync_state: 'pending', attempts: 1, last_error: 'Google no respondió' });
    expect(l1.next_attempt_at.getTime()).toBeGreaterThanOrEqual(t0.getTime() + SYNC_BACKOFF_MS[0] - 1000);
    expect(await runSync(new Date(t0.getTime() + 5_000))).toBe(0); // todavía no le toca
    expect(await runSync(new Date(t0.getTime() + SYNC_BACKOFF_MS[0] + 1_000))).toBe(1);
    expect((await links())[0]).toMatchObject({ sync_state: 'synced', attempts: 0, last_error: null });
  });

  it('un rechazo definitivo deja la cita en «failed» con el motivo, se ve en el estado y «reintentar» la vuelve a poner en cola', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    await mk(conv);
    gcal.failNext(new CalendarError('La API de Google Calendar no está habilitada en el proyecto de Google Cloud', false, false, 'api_disabled'), 'createEvent');
    await runSync();
    expect((await links())[0]).toMatchObject({ sync_state: 'failed', attempts: 1, last_error: expect.stringContaining('no está habilitada') });
    const view = await json<{ sync: { pending: number; failed: number; synced: number } }>(await call('GET', '/calendar/connection', T.alice));
    expect(view.sync).toMatchObject({ pending: 0, failed: 1, synced: 0 });
    expect(await runSync()).toBe(0); // no se reintenta sola
    const r = await call('POST', '/calendar/sync/retry', T.alice);
    expect(r.status).toBe(200);
    expect(await json<{ requeued: number }>(r)).toEqual({ requeued: 1 });
    expect(await runSync()).toBe(1);
    expect((await links())[0]).toMatchObject({ sync_state: 'synced', attempts: 0 });
    expect(await json<{ requeued: number }>(await call('POST', '/calendar/sync/retry', T.alice))).toEqual({ requeued: 0 });
  });

  it('tras agotar los intentos pasajeros queda «failed»', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    await mk(conv);
    let at = new Date();
    for (let i = 0; i < 8; i += 1) {
      gcal.failNext(new CalendarError('Google no respondió', true), 'createEvent');
      await runSync(at);
      at = new Date(at.getTime() + 2 * HOUR);
    }
    expect((await links())[0]).toMatchObject({ sync_state: 'failed', attempts: 8 });
  });

  it('si Google rechaza el permiso: la conexión pasa a «requiere reconectar» SIN gastar intentos y, al reconectar, lo pendiente sale solo', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv);
    gcal.liveRefreshTokens.clear(); // la persona revocó el acceso en su cuenta de Google
    expect(await runSync()).toBe(0);
    const view = await json<{ status: string; sync: { pending: number } }>(await call('GET', '/calendar/connection', T.alice));
    expect(view).toMatchObject({ status: 'needs_reconnect', sync: { pending: 1 } });
    expect((await links())[0]).toMatchObject({ sync_state: 'pending', attempts: 0 });
    expect(await runSync()).toBe(0); // ya no insiste hasta que reconecten
    expect(kinds('createEvent')).toHaveLength(0);
    await connect(T.alice);
    expect(await runSync()).toBe(1);
    expect((await links())[0]).toMatchObject({ sync_state: 'synced', event_id: eventIdOf(a.id) });
  });

  it('un evento que la persona borró en Google se respeta: queda «gone», se audita y no se vuelve a crear aunque se mueva la cita', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv);
    await runSync();
    gcal.events.clear(); // la persona lo borró en Google
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { starts_at: inH(20) })).status).toBe(200);
    await runSync();
    expect((await links())[0]).toMatchObject({ sync_state: 'gone', last_error: expect.stringContaining('se borró en Google') });
    expect((await admin.query(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'calendar_event' AND new_value = '"gone"'`)).rows[0].n).toBe(1);
    gcal.calls.length = 0;
    expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { starts_at: inH(30) })).status).toBe(200);
    expect((await links())[0]!.sync_state).toBe('gone'); // sigue «gone»: marcarla de nuevo no la revive
    await runSync();
    expect(gcal.calls.filter((c) => c.kind === 'createEvent' || c.kind === 'updateEvent' || c.kind === 'deleteEvent')).toHaveLength(0);
    expect(gcal.events.size).toBe(0);
  });

  it('si la cita cambia mientras se habla con Google, lo enviado queda viejo y se vuelve a reconciliar (no se da por sincronizado)', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    const a = await mk(conv);
    const original = gcal.createEvent.bind(gcal);
    let once = true;
    gcal.createEvent = async (i) => {
      if (once) {
        once = false;
        expect((await call('PATCH', `/appointments/${a.id}`, T.carol, { kind: 'Nuevo tipo' })).status).toBe(200); // cambia justo ahora
      }
      return original(i);
    };
    try {
      await runSync();
      expect((await links())[0]).toMatchObject({ sync_state: 'pending', event_id: eventIdOf(a.id) }); // el evento existe pero lo enviado ya está viejo
      await runSync();
      const l = (await links())[0]!;
      expect(l.sync_state).toBe('synced');
      expect(gcal.events.get(`${l.calendar_id}/${l.event_id}`)!.summary).toMatch(/^Nuevo tipo · /);
    } finally {
      gcal.createEvent = original;
    }
  });

  it('una tarea que murió a medias (arrendamiento vencido) se retoma; una reciente no se pisa', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    await mk(conv);
    await admin.query(`UPDATE appointment_calendar_events SET processing_started_at = now() WHERE organization_id = $1`, [ORG_A]);
    expect(await runSync()).toBe(0);
    await admin.query(`UPDATE appointment_calendar_events SET processing_started_at = now() - interval '10 minutes' WHERE organization_id = $1`, [ORG_A]);
    expect(await runSync()).toBe(1);
  });
});

describe('Citas → Google Calendar · permisos y aislamiento A↔B', () => {
  it('«reintentar» exige sesión y ser quien administra integraciones', async () => {
    expect((await call('POST', '/calendar/sync/retry')).status).toBe(401);
    expect((await call('POST', '/calendar/sync/retry', T.carol)).status).toBe(403);
    expect((await call('POST', '/calendar/sync/retry', T.alice)).status).toBe(200);
  });

  it('cada empresa sincroniza y ve solo lo suyo: la pasada de B no toca lo de A y «reintentar» de B no reencola lo de A', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    await mk(conv);
    gcal.failNext(new CalendarError('rechazada', false), 'createEvent');
    await runSync();
    expect((await links())[0]!.sync_state).toBe('failed');
    expect(await runSync(new Date(), ORG_B)).toBe(0); // B no tiene calendario ni citas
    expect(await json<{ requeued: number }>(await call('POST', '/calendar/sync/retry', T.bob))).toEqual({ requeued: 0 });
    expect((await links())[0]!.sync_state).toBe('failed'); // A no se enteró
    const viewB = await json<{ configured: boolean; sync: { pending: number; failed: number; synced: number } }>(await call('GET', '/calendar/connection', T.bob));
    expect(viewB).toMatchObject({ configured: false, sync: { pending: 0, failed: 0, synced: 0 } });
    expect(await links(ORG_B)).toHaveLength(0);
    // el vínculo de A no se puede apuntar a una cita de B (clave foránea compuesta)
    const other = await mkConv(ORG_B, IDS.bob);
    await mk(other.conv, {}, T.bob).catch(() => undefined);
    await expect(admin.query(`INSERT INTO appointment_calendar_events(id, organization_id, appointment_id) SELECT gen_random_uuid(), $1, id FROM appointments WHERE organization_id = $2 LIMIT 1`, [ORG_A, ORG_B])).rejects.toThrow(/appointment_calendar_events_appointment_fk|violates/);
  });

  it('la base rechaza un estado inválido', async () => {
    await connect(T.alice);
    const { conv } = await mkConv();
    await mk(conv);
    await expect(admin.query(`UPDATE appointment_calendar_events SET sync_state = 'inventado' WHERE organization_id = $1`, [ORG_A])).rejects.toThrow(/appointment_calendar_events_state_valid/);
  });
});
