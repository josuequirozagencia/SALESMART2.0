// M6.1 — Catálogo de productos por cola (ADR-08/ADR-51). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/queues/:id/products
//   POST /v1/queues/:id/products
//   PATCH /v1/queues/:id/products/:productId
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { OrganizationsModule } from '../../src/modules/organizations';
import { MAX_PRODUCTS_PER_QUEUE, QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, QueuesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const NOBODY = '11111111-1111-4111-8111-111111111111';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
let queueA = '';
let queueB = '';
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE queue_products, queue_members, queue_distribution_state, queues, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
interface Product { id: string; queue_id: string; name: string; kind: string; price: string; active: boolean }
interface ProductList { items: Product[]; currency: string; limits: { max_products: number } }
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const make = async (q: string, body: unknown, token = T.alice): Promise<Product> => {
  const r = await call('POST', `/queues/${q}/products`, token, body);
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(201);
  return json<Product>(r);
};
const list = async (q: string, token = T.alice): Promise<ProductList> => {
  const r = await call('GET', `/queues/${q}/products`, token);
  expect(r.status).toBe(200);
  return json<ProductList>(r);
};

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  queueA = (await json<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Ventas' }))).id;
  queueB = (await json<{ id: string }>(await call('POST', '/queues', T.bob, { name: 'Soporte' }))).id;
});

describe('catálogo de la cola', () => {
  it('el administrador crea productos y servicios; el precio se guarda exacto con 2 decimales y la lista trae la moneda de la empresa', async () => {
    const corte = await make(queueA, { name: 'Corte de cabello', kind: 'service', price: 12.5 });
    const gel = await make(queueA, { name: 'Gel fijador', price: '8' });
    const cero = await make(queueA, { name: 'Muestra', price: '0.30' });
    expect(corte).toMatchObject({ name: 'Corte de cabello', kind: 'service', price: '12.50', active: true, queue_id: queueA });
    expect(gel).toMatchObject({ kind: 'product', price: '8.00' }); // por omisión es un producto
    expect(cero.price).toBe('0.30');
    const l = await list(queueA);
    expect(l.currency).toBe('USD');
    expect(l.limits.max_products).toBe(MAX_PRODUCTS_PER_QUEUE);
    expect(l.items.map((p) => p.name)).toEqual(['Corte de cabello', 'Gel fijador', 'Muestra']); // por nombre
  });

  it('un precio inválido se rechaza: más de 2 decimales, negativo, texto, vacío o demasiado grande', async () => {
    for (const price of ['12.345', -1, 'abc', '', 1_000_000_000, '1e3', null]) {
      const r = await call('POST', `/queues/${queueA}/products`, T.alice, { name: 'X', price });
      expect(r.status, JSON.stringify(price)).toBe(400);
    }
    for (const body of [{ price: 5 }, { name: '   ', price: 5 }, { name: 'a'.repeat(121), price: 5 }, { name: 'Ok', price: 5, kind: 'otro' }, { name: 'Ok', price: 5, extra: 1 }]) {
      expect((await call('POST', `/queues/${queueA}/products`, T.alice, body)).status).toBe(400);
    }
    expect((await list(queueA)).items).toEqual([]);
  });

  it('el nombre es único por cola sin distinguir mayúsculas, también contra los desactivados; otra cola puede repetirlo', async () => {
    const p = await make(queueA, { name: 'Corte', price: 10 });
    const r = await call('POST', `/queues/${queueA}/products`, T.alice, { name: 'CORTE', price: 11 });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('PRODUCT_EXISTS');
    await call('PATCH', `/queues/${queueA}/products/${p.id}`, T.alice, { active: false });
    expect((await call('POST', `/queues/${queueA}/products`, T.alice, { name: 'corte', price: 11 })).status).toBe(409); // se reactiva, no se duplica
    const otra = (await json<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Postventa' }))).id;
    await make(otra, { name: 'Corte', price: 10 });
    const clash = await make(queueA, { name: 'Tinte', price: 30 });
    expect((await call('PATCH', `/queues/${queueA}/products/${clash.id}`, T.alice, { name: 'CORTE' })).status).toBe(409);
  });

  it('editar cambia solo lo enviado; desactivar lo deja al final de la lista; todo cambio queda en la auditoría y no cambiar nada no deja rastro', async () => {
    const a = await make(queueA, { name: 'Alisado', kind: 'service', price: 40 });
    await make(queueA, { name: 'Barba', kind: 'service', price: 8 });
    const r = await call('PATCH', `/queues/${queueA}/products/${a.id}`, T.alice, { price: '45.5', active: false });
    expect(r.status).toBe(200);
    expect(await json<Product>(r)).toMatchObject({ name: 'Alisado', kind: 'service', price: '45.50', active: false });
    expect((await list(queueA)).items.map((p) => `${p.name}:${p.active}`)).toEqual(['Barba:true', 'Alisado:false']);
    const audit = await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'queue_product' AND entity_id = $1 AND field IS NOT NULL ORDER BY field`, [a.id]);
    expect(audit.rows).toEqual([{ field: 'active', old_value: true, new_value: false }, { field: 'price', old_value: '40.00', new_value: '45.50' }]);
    const before = (await admin.query(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'queue_product'`)).rows[0].n as number;
    expect((await call('PATCH', `/queues/${queueA}/products/${a.id}`, T.alice, { price: '45.50' })).status).toBe(200);
    expect((await admin.query(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'queue_product'`)).rows[0].n).toBe(before);
    expect((await call('PATCH', `/queues/${queueA}/products/${a.id}`, T.alice, {})).status).toBe(400);
  });

  it(`el tope es de ${MAX_PRODUCTS_PER_QUEUE} productos por cola (cuentan los desactivados)`, async () => {
    await admin.query(`INSERT INTO queue_products(organization_id, id, queue_id, name, price) SELECT $1, gen_random_uuid(), $2, 'P' || g, 1 FROM generate_series(1, $3) g`, [ORG_A, queueA, MAX_PRODUCTS_PER_QUEUE]);
    const r = await call('POST', `/queues/${queueA}/products`, T.alice, { name: 'Uno más', price: 1 });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('PRODUCT_LIMIT');
  });

  it('una cola archivada o inexistente responde 404', async () => {
    await call('DELETE', `/queues/${queueA}`, T.alice);
    expect((await call('GET', `/queues/${queueA}/products`, T.alice)).status).toBe(404);
    expect((await call('POST', `/queues/${queueA}/products`, T.alice, { name: 'X', price: 1 })).status).toBe(404);
    expect((await call('GET', `/queues/${NOBODY}/products`, T.alice)).status).toBe(404);
    expect((await call('GET', `/queues/no-es-uuid/products`, T.alice)).status).toBe(400);
  });
});

describe('permisos y aislamiento A↔B', () => {
  it('un asesor no administra el catálogo (403) y sin sesión es 401', async () => {
    const p = await make(queueA, { name: 'Corte', price: 10 });
    expect((await call('GET', `/queues/${queueA}/products`, T.carol)).status).toBe(403);
    expect((await call('POST', `/queues/${queueA}/products`, T.carol, { name: 'X', price: 1 })).status).toBe(403);
    expect((await call('PATCH', `/queues/${queueA}/products/${p.id}`, T.carol, { price: 1 })).status).toBe(403);
    expect((await call('GET', `/queues/${queueA}/products`)).status).toBe(401);
  });

  it('otra empresa no ve, crea ni edita en una cola ajena: 404 uniforme; el catálogo de cada una es independiente', async () => {
    const p = await make(queueA, { name: 'Corte', price: 10 });
    await make(queueB, { name: 'Soporte premium', price: 99 }, T.bob);
    expect((await call('GET', `/queues/${queueA}/products`, T.bob)).status).toBe(404);
    expect((await call('POST', `/queues/${queueA}/products`, T.bob, { name: 'Intruso', price: 1 })).status).toBe(404);
    expect((await call('PATCH', `/queues/${queueA}/products/${p.id}`, T.bob, { price: 1 })).status).toBe(404);
    // con la cola de B y el producto de A tampoco se llega
    expect((await call('PATCH', `/queues/${queueB}/products/${p.id}`, T.bob, { price: 1 })).status).toBe(404);
    expect((await list(queueA)).items.map((x) => x.name)).toEqual(['Corte']);
    expect((await list(queueB, T.bob)).items.map((x) => x.name)).toEqual(['Soporte premium']);
    expect((await admin.query(`SELECT price FROM queue_products WHERE id = $1`, [p.id])).rows[0].price).toBe('10.00');
  });

  it('un producto no se edita por la cola equivocada de la misma empresa', async () => {
    const p = await make(queueA, { name: 'Corte', price: 10 });
    const otra = (await json<{ id: string }>(await call('POST', '/queues', T.alice, { name: 'Postventa' }))).id;
    expect((await call('PATCH', `/queues/${otra}/products/${p.id}`, T.alice, { price: 1 })).status).toBe(404);
  });
});

describe('base de datos', () => {
  const asApp = async <X,>(fn: (c: Client) => Promise<X>): Promise<X> => {
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  it('la aplicación no puede borrar productos (se desactivan) y la RLS esconde los de otra empresa', async () => {
    const p = await make(queueA, { name: 'Corte', price: 10 });
    await asApp(async (c) => {
      await expect(c.query(`DELETE FROM queue_products WHERE id = $1`, [p.id])).rejects.toThrow(/permission denied/);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      expect((await c.query(`SELECT count(*)::int n FROM queue_products`)).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    });
  });

  it('la base rechaza lo que el servidor ya filtra: precio negativo y tipo desconocido', async () => {
    await expect(admin.query(`INSERT INTO queue_products(organization_id, id, queue_id, name, price) VALUES ($1, gen_random_uuid(), $2, 'X', -1)`, [ORG_A, queueA])).rejects.toThrow(/queue_products_price_valid/);
    await expect(admin.query(`INSERT INTO queue_products(organization_id, id, queue_id, name, kind, price) VALUES ($1, gen_random_uuid(), $2, 'X', 'otro', 1)`, [ORG_A, queueA])).rejects.toThrow(/queue_products_kind_valid/);
  });
});
