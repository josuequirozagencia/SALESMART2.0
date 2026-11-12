import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalendarError, GoogleCalendarProvider } from '../../src/modules/calendar';
import { calendarProviderContract, CLIENT, REDIRECT } from './calendar.contract';

/**
 * Un Google «de juguete»: imita la pantalla de consentimiento (`/approve`), el canje de códigos con PKCE, el permiso permanente, la cuenta, los calendarios y la revocación. Sirve para probar el
 * ADAPTADOR (formato de las peticiones y de las respuestas) sin hablar con Google. **No prueba que Google real responda así**: ver «Sin validar» en el ADR-67.
 */
interface Issued { challenge: string; redirectUri: string; scope: string; used: boolean }
class SimGoogle {
  readonly codes = new Map<string, Issued>();
  readonly refresh = new Set<string>();
  readonly calendars: Array<{ id: string; summary: string; primary?: boolean; accessRole: string }> = [{ id: 'primary@example.com', summary: 'ana@example.com', primary: true, accessRole: 'owner' }];
  readonly seen: Array<{ method: string; path: string; auth: string | undefined; body: string }> = [];
  /** Eventos por calendario e id (`cancelled` imita un evento que la persona borró en Google). */
  readonly events = new Map<string, { body: Record<string, unknown>; cancelled: boolean }>();
  /** Para forzar un estado en la próxima respuesta de la ruta indicada. */
  forced: Array<{ path: string; status: number; body?: unknown }> = [];
  server!: Server;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url ?? '/', this.url);
    this.seen.push({ method: req.method ?? '', path: u.pathname, auth: req.headers.authorization, body });
    const f = this.forced.findIndex((x) => x.path === u.pathname);
    if (f >= 0) {
      const forced = this.forced.splice(f, 1)[0]!;
      return this.send(res, forced.status, forced.body ?? {});
    }
    const form = new URLSearchParams(body);
    if (u.pathname === '/approve') {
      const p = new URLSearchParams(body); // el navegador de la persona aprueba la dirección de autorización
      const code = randomBytes(8).toString('hex');
      this.codes.set(code, { challenge: p.get('code_challenge') ?? '', redirectUri: p.get('redirect_uri') ?? '', scope: p.get('scope') ?? '', used: false });
      return this.send(res, 200, { code });
    }
    if (u.pathname === '/token') {
      if (form.get('client_id') !== CLIENT.clientId || form.get('client_secret') !== CLIENT.clientSecret) return this.send(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const issued = this.codes.get(form.get('code') ?? '');
        if (!issued || issued.used) return this.send(res, 400, { error: 'invalid_grant' });
        issued.used = true;
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== issued.challenge || form.get('redirect_uri') !== issued.redirectUri) return this.send(res, 400, { error: 'invalid_grant' });
        const refresh = `1//${randomBytes(12).toString('hex')}`;
        this.refresh.add(refresh);
        return this.send(res, 200, { access_token: `ya29.${randomBytes(8).toString('hex')}`, refresh_token: refresh, expires_in: 3599, scope: issued.scope, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!this.refresh.has(form.get('refresh_token') ?? '')) return this.send(res, 400, { error: 'invalid_grant' });
        return this.send(res, 200, { access_token: `ya29.${randomBytes(8).toString('hex')}`, expires_in: 3599, token_type: 'Bearer' });
      }
      return this.send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/revoke') {
      const t = form.get('token') ?? '';
      if (!this.refresh.delete(t)) return this.send(res, 400, { error: 'invalid_token' });
      return this.send(res, 200, {});
    }
    if (!req.headers.authorization?.startsWith('Bearer ya29.')) return this.send(res, 401, { error: { code: 401 } });
    if (u.pathname === '/userinfo') return this.send(res, 200, { email: 'ana.perez@example.com', email_verified: true });
    if (u.pathname === '/calendar/v3/calendars' && req.method === 'POST') {
      const j = JSON.parse(body) as { summary: string; timeZone: string };
      const created = { id: `${randomBytes(6).toString('hex')}@group.calendar.google.com`, summary: j.summary, accessRole: 'owner' };
      this.calendars.push(created);
      return this.send(res, 200, { id: created.id, summary: j.summary, timeZone: j.timeZone });
    }
    if (u.pathname === '/calendar/v3/users/me/calendarList') {
      if (u.searchParams.get('minAccessRole') !== 'writer') return this.send(res, 400, { error: { code: 400 } });
      return this.send(res, 200, { items: this.calendars });
    }
    const ev = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (ev) {
      const cal = decodeURIComponent(ev[1]!);
      const id = ev[2] ? decodeURIComponent(ev[2]) : null;
      if (req.method === 'POST' && !id) {
        const j = JSON.parse(body) as { id: string };
        if (this.events.has(`${cal}/${j.id}`)) return this.send(res, 409, { error: { code: 409, message: 'The requested identifier already exists.' } });
        this.events.set(`${cal}/${j.id}`, { body: j as unknown as Record<string, unknown>, cancelled: false });
        return this.send(res, 200, { id: j.id, etag: `"e-${j.id}"`, status: 'confirmed' });
      }
      const cur = id ? this.events.get(`${cal}/${id}`) : undefined;
      if (req.method === 'PUT' && id) {
        if (!cur) return this.send(res, 404, { error: { code: 404 } });
        if (cur.cancelled) return this.send(res, 200, { id, etag: '"x"', status: 'cancelled' });
        cur.body = { ...JSON.parse(body), id };
        return this.send(res, 200, { id, etag: `"e2-${id}"`, status: 'confirmed' });
      }
      if (req.method === 'DELETE' && id) {
        if (!cur) return this.send(res, 404, { error: { code: 404 } });
        if (cur.cancelled) return this.send(res, 410, { error: { code: 410 } });
        cur.cancelled = true;
        res.writeHead(204);
        return void res.end();
      }
    }
    return this.send(res, 404, { error: { code: 404 } });
  }
}

const sim = new SimGoogle();
const make = (timeoutMs?: number) => new GoogleCalendarProvider({ endpoints: { authUrl: `${sim.url}/auth`, tokenUrl: `${sim.url}/token`, revokeUrl: `${sim.url}/revoke`, userinfoUrl: `${sim.url}/userinfo`, apiBase: `${sim.url}/calendar/v3/` }, ...(timeoutMs ? { timeoutMs } : {}) });

beforeAll(() => sim.start());
afterAll(() => sim.stop());

describe('GoogleCalendarProvider · contrato del puerto (contra un servidor simulado)', () => {
  it('cumple el mismo contrato que el fake', async () => {
    await calendarProviderContract(async () => ({
      provider: make(),
      approve: async (url) => {
        const r = await fetch(`${sim.url}/approve`, { method: 'POST', body: url.searchParams.toString() });
        return ((await r.json()) as { code: string }).code;
      },
    }));
  });

  it('lo que manda a Google: formulario con el secreto en el CUERPO (no en la dirección) y el acceso como Bearer', async () => {
    const p = make();
    const approve = async (): Promise<string> => {
      const url = new URL(p.authorizeUrl({ client: CLIENT, redirectUri: REDIRECT, scopes: ['a', 'b'], state: 's', codeChallenge: createHash('sha256').update('w'.repeat(43)).digest('base64url') }));
      return ((await (await fetch(`${sim.url}/approve`, { method: 'POST', body: url.searchParams.toString() })).json()) as { code: string }).code;
    };
    sim.seen.length = 0;
    const t = await p.exchangeCode({ client: CLIENT, redirectUri: REDIRECT, code: await approve(), codeVerifier: 'w'.repeat(43) });
    const token = sim.seen.find((x) => x.path === '/token')!;
    expect(token.method).toBe('POST');
    expect(token.body).toContain('grant_type=authorization_code');
    expect(token.body).toContain('code_verifier=');
    expect(token.auth).toBeUndefined();
    await p.accountEmail({ accessToken: t.accessToken });
    expect(sim.seen.find((x) => x.path === '/userinfo')!.auth).toBe(`Bearer ${t.accessToken}`);
  });
});

describe('GoogleCalendarProvider · errores', () => {
  const tokens = async (p: GoogleCalendarProvider) => {
    const url = new URL(p.authorizeUrl({ client: CLIENT, redirectUri: REDIRECT, scopes: ['a'], state: 's', codeChallenge: createHash('sha256').update('z'.repeat(43)).digest('base64url') }));
    const code = ((await (await fetch(`${sim.url}/approve`, { method: 'POST', body: url.searchParams.toString() })).json()) as { code: string }).code;
    return p.exchangeCode({ client: CLIENT, redirectUri: REDIRECT, code, codeVerifier: 'z'.repeat(43) });
  };

  it('un secreto de cliente equivocado NO es culpa de la persona: se distingue de un código inválido', async () => {
    const e = await make().exchangeCode({ client: { ...CLIENT, clientSecret: 'otro' }, redirectUri: REDIRECT, code: 'x', codeVerifier: 'y' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CalendarError);
    expect(e).toMatchObject({ credentials: false, retryable: false });
    expect((e as CalendarError).message).toMatch(/aplicación de Google de la plataforma/);
  });

  it('Google sin refresh token ⇒ rechazo claro; 5xx y 429 son pasajeros; red caída también', async () => {
    sim.forced.push({ path: '/token', status: 200, body: { access_token: 'ya29.x', expires_in: 3599, scope: 'a' } });
    const noRefresh = await tokens(make()).catch((x: unknown) => x);
    expect(noRefresh).toMatchObject({ credentials: true });
    sim.forced.push({ path: '/token', status: 503 });
    expect(await tokens(make()).catch((x: unknown) => x)).toMatchObject({ retryable: true, credentials: false });
    sim.forced.push({ path: '/token', status: 429 });
    expect(await tokens(make()).catch((x: unknown) => x)).toMatchObject({ retryable: true });
    const down = new GoogleCalendarProvider({ endpoints: { tokenUrl: 'http://127.0.0.1:1/token' }, timeoutMs: 500 });
    const e = await down.accessToken({ client: CLIENT, refreshToken: 'x' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ retryable: true });
    expect((e as CalendarError).message).not.toContain('127.0.0.1'); // el error original podría traer la dirección: no se propaga
  });

  it('401 ⇒ credenciales; 403 ⇒ falta un permiso (credenciales); 404 definitivo; 5xx pasajero; 400 definitivo', async () => {
    const p = make();
    const t = await tokens(p);
    for (const [status, want] of [[401, { credentials: true }], [403, { credentials: true }], [404, { credentials: false, retryable: false }], [500, { retryable: true }], [400, { credentials: false, retryable: false }]] as const) {
      sim.forced.push({ path: '/calendar/v3/users/me/calendarList', status });
      expect(await p.listCalendars({ accessToken: t.accessToken }).catch((x: unknown) => x), `HTTP ${status}`).toMatchObject(want);
    }
  });

  it('eventos: lo que se manda a Google es título, horas y enlace (sin teléfono ni invitados); un evento cancelado en Google se trata como «gone»', async () => {
    const p = make();
    const t = await tokens(p);
    const event = { id: 'b'.repeat(32), summary: 'Cita · Ana · Carla', description: 'Cita agendada en Sales Smart.\nhttps://app.ejemplo.test/inbox/1', startsAt: new Date('2030-02-01T15:00:00Z'), endsAt: new Date('2030-02-01T15:30:00Z'), timeZone: 'America/Guayaquil' };
    sim.seen.length = 0;
    await p.createEvent({ accessToken: t.accessToken, calendarId: 'cal@group.calendar.google.com', event });
    const sent = sim.seen.find((x) => x.method === 'POST' && x.path.endsWith('/events'))!;
    const j = JSON.parse(sent.body) as Record<string, unknown>;
    expect(j).toMatchObject({ id: event.id, summary: 'Cita · Ana · Carla', start: { dateTime: '2030-02-01T15:00:00.000Z', timeZone: 'America/Guayaquil' }, end: { dateTime: '2030-02-01T15:30:00.000Z' } });
    expect(Object.keys(j).sort()).toEqual(['description', 'end', 'extendedProperties', 'id', 'start', 'summary']);
    expect(sent.auth).toBe(`Bearer ${t.accessToken}`);
    // la persona lo borró en Google: Google responde 200 con status «cancelled» al actualizar
    sim.events.get(`cal@group.calendar.google.com/${event.id}`)!.cancelled = true;
    expect(await p.updateEvent({ accessToken: t.accessToken, calendarId: 'cal@group.calendar.google.com', eventId: event.id, event }).catch((x: unknown) => x)).toMatchObject({ kind: 'gone' });
  });

  it('403 porque la API no está habilitada en el proyecto (accessNotConfigured / SERVICE_DISABLED) ≠ falta un permiso: es de la plataforma', async () => {
    const p = make();
    const t = await tokens(p);
    for (const body of [{ error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } }, { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }]) {
      sim.forced.push({ path: '/calendar/v3/calendars', status: 403, body });
      const e = (await p.createCalendar({ accessToken: t.accessToken, name: 'X', timeZone: 'UTC' }).catch((x: unknown) => x)) as CalendarError;
      expect(e).toBeInstanceOf(CalendarError);
      expect(e).toMatchObject({ kind: 'api_disabled', credentials: false, retryable: false });
    }
    sim.forced.push({ path: '/calendar/v3/calendars', status: 403, body: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } });
    expect(await p.createCalendar({ accessToken: t.accessToken, name: 'X', timeZone: 'UTC' }).catch((x: unknown) => x)).toMatchObject({ credentials: true });
  });

  it('los mensajes de error no llevan tokens, códigos ni la respuesta de Google', async () => {
    const p = make();
    const t = await tokens(p);
    sim.forced.push({ path: '/calendar/v3/users/me/calendarList', status: 403, body: { error: { message: `token ${t.accessToken} sin permiso` } } });
    const e = (await p.listCalendars({ accessToken: t.accessToken }).catch((x: unknown) => x)) as CalendarError;
    expect(e.message).not.toContain(t.accessToken);
    expect(e.message).not.toContain('ya29');
  });

  it('revocar un permiso que Google ya no conoce (400) cuenta como revocado; otros fallos sí se reportan', async () => {
    const p = make();
    await p.revoke({ token: 'ya-no-existe' });
    sim.forced.push({ path: '/revoke', status: 500 });
    expect(await p.revoke({ token: 'x' }).catch((x: unknown) => x)).toMatchObject({ retryable: true });
  });

  it('la lista de calendarios pide solo donde se puede escribir y salta entradas sin id', async () => {
    const p = make();
    const t = await tokens(p);
    sim.calendars.push({ id: '', summary: 'roto', accessRole: 'owner' }, { id: 'lectura@x', summary: 'Solo lectura', accessRole: 'reader' });
    const list = await p.listCalendars({ accessToken: t.accessToken });
    expect(list.some((c) => c.id === '')).toBe(false);
    expect(list.find((c) => c.id === 'lectura@x')).toMatchObject({ writable: false });
    expect(list.find((c) => c.primary)).toMatchObject({ id: 'primary@example.com', writable: true });
  });
});
