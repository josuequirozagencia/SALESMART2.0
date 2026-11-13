// v11 §3 — Marca de la plataforma (solo Súper Admin): nombre, logos e icono de la aplicación. Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/branding · PUT /v1/platform/branding · PUT /v1/platform/branding/icon · DELETE /v1/platform/branding/icon
//   PUT /v1/platform/branding/logo-light · DELETE /v1/platform/branding/logo-light · PUT /v1/platform/branding/logo-dark · DELETE /v1/platform/branding/logo-dark
//   PUT /v1/platform/branding/sound · DELETE /v1/platform/branding/sound
//   GET /v1/branding · GET /v1/branding/manifest.webmanifest · GET /v1/branding/favicon · GET /v1/branding/:file
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { StorageGateway } from '../../src/modules/attachments';
import { BrandingModule } from '../../src/modules/branding';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, BrandingModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency
  root: 'f0000000-0000-4000-8000-0000000000f1',
};

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'dave' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE sessions, auth_throttle, access_sessions, organization_members, organizations, users, platform_audit, platform_branding, platform_branding_assets CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [AG1, 'agency', 'Agencia Uno']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email] of [[IDS.alice, 'alice@a.test'], [IDS.carol, 'carol@a.test'], [IDS.dave, 'dave@agencia1.test'], [IDS.root, 'root@plat.test']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.dave, AG1, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const call = (method: string, path: string, token?: string, body?: Buffer | object, headers: Record<string, string> = {}) => {
  const raw = Buffer.isBuffer(body);
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: raw ? new Uint8Array(body) : JSON.stringify(body) } : {}),
  });
};
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

interface View {
  name: string | null;
  short_name: string | null;
  effective_name: string;
  icon: { custom: boolean; version: string | null; px: number | null; has_badge: boolean };
  logo_light: { version: string; content_type: string; px: number | null } | null;
  logo_dark: { version: string; content_type: string; px: number | null } | null;
}
interface Pub { name: string; short_name: string; version: string; icon: { custom: boolean; favicon: string; apple_touch: string; icon_192: string; icon_512: string; badge_96: string }; logo: { light: string | null; dark: string | null }; sound: string | null }

// ---- imágenes reales (sharp): un círculo índigo con transparencia, uno opaco, etc.
const circleSvg = (n: number): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}"><circle cx="${n / 2}" cy="${n / 2}" r="${n / 2 - 4}" fill="#4f46e5"/></svg>`);
const pngCircle = (n: number): Promise<Buffer> => sharp(circleSvg(n)).png().toBuffer(); // con transparencia en las esquinas
const pngOpaque = (w: number, h: number): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: '#4f46e5' } }).png().toBuffer();
const webp = (w: number, h: number): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: '#112233' } }).webp().toBuffer();
const jpeg = (n: number): Promise<Buffer> => sharp({ create: { width: n, height: n, channels: 3, background: '#112233' } }).jpeg().toBuffer();
const size = async (b: Buffer): Promise<string> => { const m = await sharp(b).metadata(); return `${m.width}x${m.height}`; };
// ---- sonidos de prueba construidos a mano: la validación es por contenido, no por extensión
/** MP3 mínimo: etiqueta ID3v2 opcional y cuadros MPEG-1 capa III de 128 kbps / 44,1 kHz (cabecera FF FB 90 64, cuadro de 417 bytes). */
function mp3(o: { id3?: boolean; frames?: number; padding?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  if (o.id3) parts.push(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x10', 'latin1'), Buffer.alloc(16));
  if (o.padding) parts.push(Buffer.alloc(o.padding));
  for (let i = 0; i < (o.frames ?? 3); i++) parts.push(Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413));
  return Buffer.concat(parts);
}
const box = (type: string, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + b.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, b]);
};
/** M4A mínimo: `ftyp` M4A y un manejador de pista (`soun` = audio, `vide` = video). */
function m4a(handler = 'soun', brand = 'M4A '): Buffer {
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
  return Buffer.concat([box('ftyp', Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from('M4A isom', 'latin1')), box('moov', box('trak', box('mdia', hdlr))), box('mdat', Buffer.alloc(300))]);
}
const bodyOf = async (r: Response): Promise<Buffer> => Buffer.from(await r.arrayBuffer());

const storage = () => app.get(StorageGateway, { strict: false }).fake;
const objects = (): string[] => [...storage().objects.keys()].sort();
const audits = async () => (await admin.query(`SELECT action, details, actor_user_id FROM platform_audit WHERE action LIKE 'branding.%' ORDER BY at, id`)).rows as Array<{ action: string; details: Record<string, unknown>; actor_user_id: string }>;
const rows = async () => (await admin.query('SELECT asset FROM platform_branding_assets ORDER BY asset')).rows.map((r: { asset: string }) => r.asset);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER', 'PROVIDER_CREDENTIALS_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, STORAGE_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  const fake = storage();
  fake.objects.clear();
  fake.down = false;
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('acceso: solo el Súper Admin cambia la marca', () => {
  it('sin sesión es 401; asesora, administrador de empresa y agencia reciben 403 y no se guarda nada', async () => {
    const img = await pngCircle(600);
    const attempts: Array<[string, string, Buffer | object | undefined]> = [
      ['GET', '/platform/branding', undefined],
      ['PUT', '/platform/branding', { name: 'Mi Marca', short_name: null }],
      ['PUT', '/platform/branding/icon', img],
      ['DELETE', '/platform/branding/icon', undefined],
      ['PUT', '/platform/branding/logo-light', img],
      ['DELETE', '/platform/branding/logo-light', undefined],
      ['PUT', '/platform/branding/logo-dark', img],
      ['DELETE', '/platform/branding/logo-dark', undefined],
      ['PUT', '/platform/branding/sound', mp3()],
      ['DELETE', '/platform/branding/sound', undefined],
    ];
    for (const [m, p, b] of attempts) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      for (const who of ['alice', 'carol', 'dave'] as const) expect((await call(m, p, T[who], b)).status, `${who} ${m} ${p}`).toBe(403);
    }
    expect(objects()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM platform_branding')).rows[0].n).toBe(0);
  });

  it('la aplicación de cliente (app_rw) no puede leer ni escribir las tablas de la marca', async () => {
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      for (const t of ['platform_branding', 'platform_branding_assets']) {
        await expect(rw.query(`SELECT * FROM ${t}`), t).rejects.toThrow(/permission denied|permiso denegado/i);
        await expect(rw.query(`DELETE FROM ${t}`), t).rejects.toThrow(/permission denied|permiso denegado/i);
      }
    } finally {
      await rw.end();
    }
  });

  it('la base rechaza nombres y archivos fuera de las reglas', async () => {
    await expect(admin.query(`INSERT INTO platform_branding(id, app_name) VALUES (1, '<b>')`)).rejects.toThrow(/platform_branding_name_valid/);
    await expect(admin.query(`INSERT INTO platform_branding(id, app_name) VALUES (1, 'x')`)).rejects.toThrow(/platform_branding_name_valid/);
    await expect(admin.query(`INSERT INTO platform_branding(id, app_name, app_short_name) VALUES (1, 'Ok', '1234567890123')`)).rejects.toThrow(/platform_branding_short_name_valid/);
    await expect(admin.query(`INSERT INTO platform_branding_assets(asset, storage_key, content_type, bytes, version) VALUES ('logo-svg', 'platform/branding/x-${'0'.repeat(36)}', 'image/png', 1, gen_random_uuid())`)).rejects.toThrow(/platform_branding_assets_name/);
    await expect(admin.query(`INSERT INTO platform_branding_assets(asset, storage_key, content_type, bytes, version) VALUES ('logo-light', 'org/${ORG_A}/x', 'image/png', 1, gen_random_uuid())`)).rejects.toThrow(/platform_branding_assets_key/);
    await expect(admin.query(`INSERT INTO platform_branding_assets(asset, storage_key, content_type, bytes, version) VALUES ('logo-light', 'platform/branding/logo-light-${'0'.repeat(36)}', 'image/svg+xml', 1, gen_random_uuid())`)).rejects.toThrow(/platform_branding_assets_type/);
  });
});

describe('lo público: sin nada propio entrega los valores por defecto y no revela nada de las empresas', () => {
  it('GET /branding: nombre por defecto, sin logos propios y direcciones versionadas; cache corta y ETag', async () => {
    const r = await call('GET', '/branding');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    const p = await json<Pub>(r);
    expect(p).toEqual({
      name: 'Sales Smart 2.0',
      short_name: 'Sales Smart',
      version: 'default-1',
      icon: { custom: false, favicon: '/v1/branding/favicon?v=default-1', apple_touch: '/v1/branding/apple-touch-icon.png?v=default-1', icon_192: '/v1/branding/icon-192.png?v=default-1', icon_512: '/v1/branding/icon-512.png?v=default-1', badge_96: '/v1/branding/badge-96.png?v=default-1' },
      logo: { light: null, dark: null },
      sound: null,
    });
    expect(JSON.stringify(p)).not.toMatch(/Barbería|Agencia Uno|alice|root@/);
    const etag = r.headers.get('etag')!;
    expect((await call('GET', '/branding', undefined, undefined, { 'if-none-match': etag })).status).toBe(304);
  });

  it('el favicon por omisión es el SVG propio; los iconos y el badge por omisión son PNG del tamaño pedido (nunca un 404)', async () => {
    const f = await call('GET', '/branding/favicon');
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('image/svg+xml');
    expect(await f.text()).toContain('<svg');
    for (const [file, px] of [['icon-32.png', 32], ['icon-48.png', 48], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['badge-96.png', 96]] as const) {
      const r = await call('GET', `/branding/${file}`);
      expect(r.status, file).toBe(200);
      expect(r.headers.get('content-type'), file).toBe('image/png');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await size(await bodyOf(r)), file).toBe(`${px}x${px}`);
    }
  });

  it('un archivo desconocido o un logo sin subir responde 404 con el error estándar; el sonido sin subir también es 404 (la aplicación usa su tono) y nada fuera de la lista se puede pedir', async () => {
    for (const f of ['logo-light', 'logo-dark', 'nada.png', 'sound', '..%2Fsecretos', 'toString', '__proto__']) {
      const r = await call('GET', `/branding/${f}`);
      expect(r.status, f).toBe(404);
      expect(await json<{ error: { code: string } }>(r)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('el manifest por omisión lleva el nombre y los iconos de 192 y 512', async () => {
    const r = await call('GET', '/branding/manifest.webmanifest');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(await json(r)).toMatchObject({ name: 'Sales Smart 2.0', short_name: 'Sales Smart', start_url: '/', display: 'standalone', icons: [{ src: '/v1/branding/icon-192.png?v=default-1', sizes: '192x192', type: 'image/png' }, { src: '/v1/branding/icon-512.png?v=default-1', sizes: '512x512' }] });
  });
});

describe('nombre de la plataforma', () => {
  it('se cambia, se ve en lo público y en el manifest, queda auditado, y volver al valor por defecto lo restaura', async () => {
    const up = await call('PUT', '/platform/branding', T.root, { name: '  Mi   Marca  ', short_name: 'MiMarca' });
    expect(up.status, await up.clone().text()).toBe(200);
    expect(await json<View>(up)).toMatchObject({ name: 'Mi Marca', short_name: 'MiMarca', effective_name: 'Mi Marca' });
    expect(await json<Pub>(await call('GET', '/branding'))).toMatchObject({ name: 'Mi Marca', short_name: 'MiMarca' });
    expect(await json(await call('GET', '/branding/manifest.webmanifest'))).toMatchObject({ name: 'Mi Marca', short_name: 'MiMarca' });
    // sin nombre corto: el manifest usa los primeros 12 caracteres del nombre
    await call('PUT', '/platform/branding', T.root, { name: 'Una Marca Con Nombre Largo', short_name: null });
    expect(await json<Pub>(await call('GET', '/branding'))).toMatchObject({ name: 'Una Marca Con Nombre Largo', short_name: 'Una Marca Co' });
    const back = await call('PUT', '/platform/branding', T.root, { name: null, short_name: null });
    expect(await json<View>(back)).toMatchObject({ name: null, effective_name: 'Sales Smart 2.0' });
    expect((await json<Pub>(await call('GET', '/branding'))).name).toBe('Sales Smart 2.0');
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(['branding.name.set', 'branding.name.set', 'branding.name.cleared']);
    expect(a[0]).toMatchObject({ actor_user_id: IDS.root, details: { before: { name: null }, after: { name: 'Mi Marca', short_name: 'MiMarca' } } });
  });

  it('rechaza lo que no es un nombre: muy corto o largo, con HTML, solo el corto, campos de más o tipos equivocados', async () => {
    const bad: unknown[] = [
      { name: 'A', short_name: null },
      { name: 'x'.repeat(41), short_name: null },
      { name: '<script>alert(1)</script>', short_name: null },
      { name: 'Ok', short_name: '1234567890123' },
      { name: 'Ok', short_name: '<b>' },
      { name: null, short_name: 'Corto' },
      { name: 'Ok', short_name: null, extra: 1 },
      { name: 5, short_name: null },
      { name: 'Ok' },
      {},
    ];
    for (const b of bad) expect((await call('PUT', '/platform/branding', T.root, b as object)).status, JSON.stringify(b)).toBe(400);
    expect((await admin.query('SELECT count(*)::int AS n FROM platform_branding')).rows[0].n).toBe(0);
    expect(await audits()).toEqual([]);
  });
});

describe('icono de la aplicación', () => {
  it('un PNG cuadrado con transparencia genera favicon, apple-touch, 192, 512 y el badge; se entrega sin sesión, versionado y con caché larga', async () => {
    const up = await call('PUT', '/platform/branding/icon', T.root, await pngCircle(1024));
    expect(up.status, await up.clone().text()).toBe(200);
    const v = await json<View>(up);
    expect(v.icon).toMatchObject({ custom: true, px: 1024, has_badge: true });
    expect(await rows()).toEqual(['badge-96', 'icon-180', 'icon-192', 'icon-32', 'icon-48', 'icon-512']);
    expect(objects()).toHaveLength(6);
    expect(objects().every((k) => new RegExp(`^platform/branding/(icon-\\d+|badge-96)-${v.icon.version}$`).test(k))).toBe(true);
    const pub = await json<Pub>(await call('GET', '/branding'));
    expect(pub.icon.custom).toBe(true);
    expect(pub.version).toBe(v.icon.version);
    expect(pub.icon.icon_192).toBe(`/v1/branding/icon-192.png?v=${v.icon.version}`);
    for (const [file, px] of [['icon-32.png', 32], ['icon-48.png', 48], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['badge-96.png', 96]] as const) {
      const r = await call('GET', `/branding/${file}?v=${v.icon.version}`);
      expect(r.status, file).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await size(await bodyOf(r)), file).toBe(`${px}x${px}`);
    }
    // sin la versión vigente, caché corta; con la misma versión, 304
    const noV = await call('GET', '/branding/icon-192.png');
    expect(noV.headers.get('cache-control')).toBe('public, max-age=300');
    expect((await call('GET', '/branding/icon-192.png', undefined, undefined, { 'if-none-match': `"${v.icon.version}"` })).status).toBe(304);
    // el favicon pasa a ser el PNG de 48 px
    const fav = await call('GET', '/branding/favicon');
    expect(fav.headers.get('content-type')).toBe('image/png');
    expect(await size(await bodyOf(fav))).toBe('48x48');
    expect(await audits()).toMatchObject([{ action: 'branding.icon.set', actor_user_id: IDS.root, details: { px: 1024, has_badge: true, version: v.icon.version } }]);
  });

  it('el badge es una silueta blanca con el alfa de la imagen: esquinas transparentes y centro blanco', async () => {
    await call('PUT', '/platform/branding/icon', T.root, await pngCircle(600));
    const badge = await bodyOf(await call('GET', '/branding/badge-96.png'));
    const { data, info: i } = await sharp(badge).raw().toBuffer({ resolveWithObject: true });
    expect(i.channels).toBe(4);
    const px = (x: number, y: number) => [...data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
    expect(px(0, 0)[3]).toBe(0); // esquina: transparente
    expect(px(48, 48)).toEqual([255, 255, 255, 255]); // centro: blanco opaco
  });

  it('sin transparencia no se genera el badge (el servidor entrega el de por omisión) y el resto sí', async () => {
    const up = await call('PUT', '/platform/branding/icon', T.root, await pngOpaque(512, 512));
    expect(up.status).toBe(200);
    expect((await json<View>(up)).icon).toMatchObject({ custom: true, has_badge: false });
    expect(await rows()).toEqual(['icon-180', 'icon-192', 'icon-32', 'icon-48', 'icon-512']);
    const badge = await call('GET', '/branding/badge-96.png');
    expect(badge.status).toBe(200);
    expect(await size(await bodyOf(badge))).toBe('96x96');
    expect((await json<Pub>(await call('GET', '/branding'))).icon.badge_96).toContain('?v=default-1');
  });

  it('cambiar el icono reemplaza todas las variantes y borra los archivos anteriores; el badge desaparece si el nuevo es opaco', async () => {
    const first = await json<View>(await call('PUT', '/platform/branding/icon', T.root, await pngCircle(600)));
    const before = objects();
    expect(before).toHaveLength(6);
    const second = await json<View>(await call('PUT', '/platform/branding/icon', T.root, await pngOpaque(700, 700)));
    expect(second.icon.version).not.toBe(first.icon.version);
    expect(objects()).toHaveLength(5);
    expect(objects().every((k) => k.endsWith(second.icon.version!))).toBe(true);
    expect(await rows()).toEqual(['icon-180', 'icon-192', 'icon-32', 'icon-48', 'icon-512']);
  });

  it('rechaza lo que no es un icono válido y no deja nada guardado ni auditado', async () => {
    const big = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#4f46e5' } }).png().toBuffer();
    const noise = await sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(noise.length).toBeGreaterThan(1024 * 1024);
    const cases: Array<[string, Buffer, number, string]> = [
      ['SVG', circleSvg(600), 400, 'ICON_NOT_PNG'],
      ['JPEG', await jpeg(600), 400, 'ICON_NOT_PNG'],
      ['WebP', await webp(600, 600), 400, 'ICON_NOT_PNG'],
      ['texto con extensión falsa', Buffer.from('esto no es una imagen'), 400, 'ICON_NOT_PNG'],
      ['firma PNG con el resto roto', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]), 400, 'ICON_CORRUPT'],
      ['no cuadrada', await pngOpaque(800, 600), 400, 'ICON_NOT_SQUARE'],
      ['menor de 512 px', await pngOpaque(256, 256), 400, 'ICON_TOO_SMALL'],
      ['mayor de 4096 px', big, 400, 'ICON_TOO_BIG'],
      ['de más de 1 MB', noise, 413, 'ICON_TOO_LARGE'],
      ['vacía', Buffer.alloc(0), 400, 'ICON_EMPTY'],
    ];
    for (const [name, buf, status, code] of cases) {
      const r = await call('PUT', '/platform/branding/icon', T.root, buf.length > 0 ? buf : undefined);
      // un cuerpo vacío llega como «sin cuerpo»: el servidor lo trata igual
      expect(r.status, name).toBe(status);
      expect(await json<{ error: { code: string } }>(r), name).toMatchObject({ error: { code } });
    }
    expect(objects()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('quitar el icono vuelve a los valores por defecto, borra los archivos y se puede repetir', async () => {
    await call('PUT', '/platform/branding/icon', T.root, await pngCircle(600));
    const del = await call('DELETE', '/platform/branding/icon', T.root);
    expect(del.status).toBe(200);
    expect((await json<View>(del)).icon).toMatchObject({ custom: false, version: null, has_badge: false });
    expect(objects()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect((await json<Pub>(await call('GET', '/branding'))).version).toBe('default-1');
    expect((await call('DELETE', '/platform/branding/icon', T.root)).status).toBe(200); // repetir no es un error
    expect((await audits()).map((x) => x.action)).toEqual(['branding.icon.set', 'branding.icon.cleared', 'branding.icon.cleared']);
  });

  it('sin almacenamiento disponible responde 503 y no deja referencias ni archivos a medias', async () => {
    storage().down = true;
    const r = await call('PUT', '/platform/branding/icon', T.root, await pngCircle(600));
    expect(r.status).toBe(503);
    storage().down = false;
    expect(objects()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(await audits()).toEqual([]);
  });
});

describe('logos', () => {
  it('se suben en PNG o WebP para fondo claro y oscuro; sin el oscuro se usa el claro; se entregan sin sesión', async () => {
    const light = await pngOpaque(400, 120);
    const up = await call('PUT', '/platform/branding/logo-light', T.root, light);
    expect(up.status, await up.clone().text()).toBe(200);
    expect((await json<View>(up)).logo_light).toMatchObject({ content_type: 'image/png', px: 400 });
    let pub = await json<Pub>(await call('GET', '/branding'));
    expect(pub.logo.light).toMatch(/^\/v1\/branding\/logo-light\?v=/);
    expect(pub.logo.dark).toBe(pub.logo.light); // sin versión oscura, la clara
    const lightGet = await call('GET', `/branding/logo-light`);
    expect(lightGet.status).toBe(200);
    expect(lightGet.headers.get('content-type')).toBe('image/png');
    expect((await bodyOf(lightGet)).equals(light)).toBe(true);
    expect((await bodyOf(await call('GET', '/branding/logo-dark'))).equals(light)).toBe(true);

    const dark = await webp(300, 90);
    const upDark = await call('PUT', '/platform/branding/logo-dark', T.root, dark);
    expect(upDark.status).toBe(200);
    expect((await json<View>(upDark)).logo_dark).toMatchObject({ content_type: 'image/webp', px: 300 });
    pub = await json<Pub>(await call('GET', '/branding'));
    expect(pub.logo.dark).toMatch(/^\/v1\/branding\/logo-dark\?v=/);
    const darkGet = await call('GET', '/branding/logo-dark');
    expect(darkGet.headers.get('content-type')).toBe('image/webp');
    expect((await bodyOf(darkGet)).equals(dark)).toBe(true);
    expect(objects()).toHaveLength(2);
    expect(await rows()).toEqual(['logo-dark', 'logo-light']);
  });

  it('rechaza SVG, otros formatos, más de 1024 px de ancho, rotos y más de 1 MB', async () => {
    const wide = await pngOpaque(1025, 100);
    const staticWebp = await webp(40, 120); // control positivo: un WebP estático sí pasa
    const noise = await sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const cases: Array<[string, Buffer, number, string]> = [
      ['SVG', circleSvg(200), 400, 'LOGO_UNSUPPORTED'],
      ['JPEG', await jpeg(200), 400, 'LOGO_UNSUPPORTED'],
      ['más de 1024 px de ancho', wide, 400, 'LOGO_TOO_WIDE'],
      ['firma PNG con el resto roto', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(500)]), 400, 'LOGO_CORRUPT'],
      ['de más de 1 MB', noise, 413, 'LOGO_TOO_LARGE'],
    ];
    for (const [name, buf, status, code] of cases) {
      const r = await call('PUT', '/platform/branding/logo-light', T.root, buf);
      expect(r.status, name).toBe(status);
      expect(await json<{ error: { code: string } }>(r), name).toMatchObject({ error: { code } });
    }
    expect((await call('PUT', '/platform/branding/logo-dark', T.root, staticWebp)).status).toBe(200);
    expect(await rows()).toEqual(['logo-dark']);
  });

  it('quitar un logo borra su archivo y su referencia; la empresa no tiene nada que ver', async () => {
    await call('PUT', '/platform/branding/logo-light', T.root, await pngOpaque(300, 80));
    expect(objects()).toHaveLength(1);
    expect((await call('DELETE', '/platform/branding/logo-light', T.root)).status).toBe(200);
    expect(objects()).toEqual([]);
    expect((await json<Pub>(await call('GET', '/branding'))).logo).toEqual({ light: null, dark: null });
    expect((await audits()).map((x) => x.action)).toEqual(['branding.logo.set', 'branding.logo.cleared']);
  });
});

describe('sonido de notificación', () => {
  it('un MP3 (con o sin etiqueta ID3) o un M4A válidos se guardan, se entregan sin sesión con su tipo, versionados y con caché larga, y quedan auditados', async () => {
    const mp = mp3({ id3: true, padding: 8 });
    const r = await call('PUT', '/platform/branding/sound', T.root, mp);
    expect(r.status).toBe(200);
    const v = await json<{ sound: { version: string; bytes: number; content_type: string } | null }>(r);
    expect(v.sound).toMatchObject({ bytes: mp.length, content_type: 'audio/mpeg' });
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatch(/^platform\/branding\/sound-[0-9a-f-]{36}$/);
    const pub = await json<Pub>(await call('GET', '/branding'));
    expect(pub.sound).toBe(`/v1/branding/sound?v=${v.sound!.version}`);
    const f = await call('GET', pub.sound!.replace('/v1', ''));
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('audio/mpeg');
    expect(f.headers.get('x-content-type-options')).toBe('nosniff');
    expect(f.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(f.headers.get('etag')).toBe(`"${v.sound!.version}"`);
    expect((await bodyOf(f)).equals(mp)).toBe(true);
    expect((await call('GET', '/branding/sound', undefined, undefined, { 'if-none-match': `"${v.sound!.version}"` })).status).toBe(304);
    // sin la versión: caché corta
    expect((await call('GET', '/branding/sound')).headers.get('cache-control')).toBe('public, max-age=300');
    // sin ID3, y un M4A en su lugar
    expect((await call('PUT', '/platform/branding/sound', T.root, mp3())).status).toBe(200);
    const r2 = await call('PUT', '/platform/branding/sound', T.root, m4a());
    expect(r2.status).toBe(200);
    expect((await json<{ sound: { content_type: string } }>(r2)).sound.content_type).toBe('audio/mp4');
    expect((await call('GET', '/branding/sound')).headers.get('content-type')).toBe('audio/mp4');
    expect(objects()).toHaveLength(1);
    expect(await rows()).toEqual(['sound']);
    expect((await audits()).map((x) => x.action)).toEqual(['branding.sound.set', 'branding.sound.set', 'branding.sound.set']);
    expect((await audits())[0]!.actor_user_id).toBe(IDS.root);
  });

  it('el estado del Súper Admin trae el sonido; sin sonido, null', async () => {
    expect((await json<{ sound: unknown }>(await call('GET', '/platform/branding', T.root))).sound).toBeNull();
    await call('PUT', '/platform/branding/sound', T.root, mp3());
    expect((await json<{ sound: { content_type: string } }>(await call('GET', '/platform/branding', T.root))).sound?.content_type).toBe('audio/mpeg');
  });

  it('rechaza por contenido lo que no es un sonido: extensión falsa, SVG, imagen, video MP4, MPEG de otra capa, vacío y más de 200 KB; no deja nada guardado ni auditado', async () => {
    const png = await pngCircle(64);
    const cases: Array<[string, Buffer, number, string]> = [
      ['vacío', Buffer.alloc(0), 400, 'SOUND_EMPTY'],
      ['texto con «extensión» mp3', Buffer.from('esto no es un mp3, aunque se llame sonido.mp3'), 400, 'SOUND_FORMAT_INVALID'],
      ['SVG', circleSvg(40), 400, 'SOUND_FORMAT_INVALID'],
      ['PNG', png, 400, 'SOUND_FORMAT_INVALID'],
      ['video MP4 (manejador de video)', m4a('vide', 'isom'), 400, 'SOUND_FORMAT_INVALID'],
      ['MP4 sin pista de audio', m4a('meta'), 400, 'SOUND_FORMAT_INVALID'],
      ['ID3 sin ningún cuadro detrás', Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x10', 'latin1'), Buffer.alloc(16)]), 400, 'SOUND_FORMAT_INVALID'],
      ['cuadro MPEG de capa II (no MP3)', Buffer.concat([Buffer.from([0xff, 0xfd, 0x90, 0x64]), Buffer.alloc(400)]), 400, 'SOUND_FORMAT_INVALID'],
      ['más de 200 KB', mp3({ frames: 600 }), 413, 'SOUND_TOO_LARGE'],
    ];
    for (const [name, body, status, code] of cases) {
      const r = await call('PUT', '/platform/branding/sound', T.root, body);
      expect(r.status, name).toBe(status);
      expect(await json<{ error: { code: string } }>(r), name).toMatchObject({ error: { code } });
    }
    expect(objects()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(await audits()).toEqual([]);
    // el límite es exacto: 200 KB justos sí
    const exact = Buffer.concat([mp3({ frames: 1 }), Buffer.alloc(200 * 1024 - 417)]);
    expect(exact.length).toBe(200 * 1024);
    expect((await call('PUT', '/platform/branding/sound', T.root, exact)).status).toBe(200);
  });

  it('restaurar el sonido por defecto borra el archivo y la referencia, el público vuelve a no tener sonido y se puede repetir', async () => {
    await call('PUT', '/platform/branding/sound', T.root, mp3());
    expect(objects()).toHaveLength(1);
    expect((await call('DELETE', '/platform/branding/sound', T.root)).status).toBe(200);
    expect(objects()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect((await json<Pub>(await call('GET', '/branding'))).sound).toBeNull();
    expect((await call('GET', '/branding/sound')).status).toBe(404);
    expect((await call('DELETE', '/platform/branding/sound', T.root)).status).toBe(200);
    expect((await audits()).map((x) => x.action)).toEqual(['branding.sound.set', 'branding.sound.cleared', 'branding.sound.cleared']);
  });

  it('sin almacenamiento disponible responde 503 y no deja referencias a medias; el sonido no toca los logos ni el icono', async () => {
    storage().down = true;
    const r = await call('PUT', '/platform/branding/sound', T.root, mp3());
    expect(r.status).toBe(503);
    expect(await rows()).toEqual([]);
    storage().down = false;
    await call('PUT', '/platform/branding/logo-light', T.root, await pngOpaque(300, 80));
    await call('PUT', '/platform/branding/sound', T.root, mp3());
    await call('DELETE', '/platform/branding/sound', T.root);
    expect(await rows()).toEqual(['logo-light']);
  });

  it('el archivo solo se pide por su nombre exacto', async () => {
    await call('PUT', '/platform/branding/sound', T.root, mp3());
    for (const f of ['sound.mp3', 'sound.m4a', 'Sound']) expect((await call('GET', `/branding/${f}`)).status, f).toBe(404);
  });
});

describe('límite de peticiones en lo público', () => {
  it('pasado el tope por minuto de una misma IP responde 429 con Retry-After y el error estándar', async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 300 && !limited; i++) {
      const r = await call('GET', '/branding/icon-192.png');
      if (r.status === 429) limited = r;
      else await r.arrayBuffer();
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await json<{ error: { code: string } }>(limited!)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
