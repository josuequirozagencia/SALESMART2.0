import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { API_LOG, STATE_FILE, type E2EState } from './global-setup';

export const PASSWORD = 'Clave-E2E-Segura-1';

export const state = (): E2EState => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2EState;
export const uniqueEmail = (tag = 'u'): string => `${tag}-${randomBytes(4).toString('hex')}@empresa-e2e.test`;

interface LogLine { msg?: string; code?: string; resetUrl?: string; inviteUrl?: string }
function logLines(): LogLine[] {
  if (!existsSync(API_LOG)) return [];
  return readFileSync(API_LOG, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LogLine]; } catch { return []; } });
}
/** Marca la posición actual del log de la API (los correos fake se leen DESPUÉS de esta marca). */
export const mailMark = (): number => logLines().length;

/** Espera el siguiente correo fake del tipo indicado. El correo del destinatario viene redactado en el log; las pruebas corren en serie. */
export async function nextMail(kind: 'verificación' | 'restablecimiento' | 'invitación', since: number): Promise<{ code?: string; resetUrl?: string; inviteUrl?: string }> {
  for (let i = 0; i < 100; i++) {
    const hit = logLines().slice(since).find((l) => l.msg?.includes('DEV ONLY') && l.msg.includes(kind));
    if (hit) return hit.code ? { code: hit.code } : hit.resetUrl ? { resetUrl: hit.resetUrl } : hit.inviteUrl ? { inviteUrl: hit.inviteUrl } : {};
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no llegó el correo de ${kind}`);
}

const FAKE_CAPTCHA = 'fake-pass';
const json = { 'content-type': 'application/json' };

/** Crea una cuenta verificada por la API (rápido; la UI de registro se prueba aparte). Devuelve su correo. */
export async function createAccount(request: APIRequestContext, email = uniqueEmail(), password = PASSWORD): Promise<string> {
  const { apiBase } = state();
  const since = mailMark();
  const r = await request.post(`${apiBase}/v1/auth/signup`, { headers: json, data: { email, password, full_name: 'Ana E2E', phone: '+593984217730', organization_name: 'Empresa E2E', captcha_token: FAKE_CAPTCHA } });
  expect(r.status()).toBe(202);
  const { code } = await nextMail('verificación', since);
  expect((await request.post(`${apiBase}/v1/auth/verify`, { headers: json, data: { email, code } })).status()).toBe(200);
  return email;
}

export async function apiLogin(request: APIRequestContext, email: string, password = PASSWORD): Promise<string> {
  const { apiBase } = state();
  const r = await request.post(`${apiBase}/v1/auth/login`, { headers: json, data: { email, password, token_transport: 'body' } });
  expect(r.status()).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

export async function adminToken(request: APIRequestContext): Promise<string> {
  const s = state();
  return apiLogin(request, s.rootEmail, s.rootPassword);
}

export interface TrialItem { id: string; owner_email: string; owner_name: string | null; owner_phone: string | null }
export async function pendingTrialItemOf(request: APIRequestContext, email: string): Promise<TrialItem> {
  const { apiBase } = state();
  const token = await adminToken(request);
  const r = await request.get(`${apiBase}/v1/platform/trials?extension=pending&limit=100`, { headers: { authorization: `Bearer ${token}` } });
  const items = ((await r.json()) as { items: TrialItem[] }).items;
  const mine = items.find((i) => i.owner_email === email);
  if (!mine) throw new Error(`no hay solicitud pendiente de ${email}`);
  return mine;
}

export async function pendingTrialOf(request: APIRequestContext, email: string): Promise<string> {
  return (await pendingTrialItemOf(request, email)).id;
}

/** La persona cliente pide su extensión (la solicitud llega a la consola del Súper Admin). */
export async function requestExtensionViaApi(request: APIRequestContext, email: string, reason: string): Promise<void> {
  const { apiBase } = state();
  const token = await apiLogin(request, email);
  expect((await request.post(`${apiBase}/v1/trials/me/extension`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { reason } })).status()).toBe(202);
}

export async function trialOf(request: APIRequestContext, email: string): Promise<{ status: string; extension: { status: string; days_granted: number | null } }> {
  const { apiBase } = state();
  const token = await apiLogin(request, email);
  return (await (await request.get(`${apiBase}/v1/trials/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { status: string; extension: { status: string; days_granted: number | null } };
}

export async function decide(request: APIRequestContext, trialId: string, action: 'approve' | 'deny'): Promise<void> {
  const { apiBase } = state();
  const token = await adminToken(request);
  expect((await request.post(`${apiBase}/v1/platform/trials/${trialId}/${action}`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
}

/** Adelanta el vencimiento de la prueba de un usuario (equivale a que hayan pasado los días). */
export async function expireTrialOf(email: string): Promise<void> {
  const c = new pg.Client({ connectionString: state().adminDbUrl });
  await c.connect();
  try {
    // Viajar en el tiempo = reescribir started_at, que el trigger de la BD declara inmutable: solo el superusuario del E2E lo salta
    await c.query('SET session_replication_role = replica');
    const r = await c.query(
      `UPDATE trials SET ends_at = now() - interval '1 hour', started_at = now() - interval '8 days'
        WHERE organization_id = (SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1)`,
      [email],
    );
    expect(r.rowCount).toBe(1);
  } finally {
    await c.end();
  }
}

export async function uiLogin(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
