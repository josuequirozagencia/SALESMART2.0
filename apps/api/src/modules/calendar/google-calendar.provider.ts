import { CalendarError, type CalendarEventInput, type CalendarEventRef, type CalendarInfo, type CalendarProvider, type OAuthClient, type TokenSet } from './calendar.ports';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface GoogleEndpoints {
  /** Pantalla de autorización de Google. */
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  userinfoUrl: string;
  /** Base de la API de Calendar v3 (sin barra final). */
  apiBase: string;
}

const DEFAULT_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  apiBase: 'https://www.googleapis.com/calendar/v3',
};

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

/**
 * Adaptador de Google Calendar (v11 Pista G, ADR-67) sobre `fetch`. Las direcciones se pueden sustituir (pruebas contra un servidor simulado). NO guarda credenciales: las recibe en cada llamada.
 * Los mensajes de error no llevan tokens, códigos ni la respuesta de Google. **Probado solo contra un servidor simulado**: ver «Sin validar» en el ADR-67.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = 'google' as const;
  private readonly ep: GoogleEndpoints;
  private readonly timeoutMs: number;

  constructor(opts: { endpoints?: Partial<GoogleEndpoints>; timeoutMs?: number } = {}) {
    const merged = { ...DEFAULT_ENDPOINTS, ...opts.endpoints };
    this.ep = { ...merged, apiBase: merged.apiBase.replace(/\/$/, '') };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  authorizeUrl(i: { client: OAuthClient; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string }): string {
    const u = new URL(this.ep.authUrl);
    u.searchParams.set('client_id', i.client.clientId);
    u.searchParams.set('redirect_uri', i.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', i.scopes.join(' '));
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('access_type', 'offline'); // refresh token
    u.searchParams.set('prompt', 'consent'); // Google solo entrega el refresh token en el consentimiento
    u.searchParams.set('include_granted_scopes', 'false'); // no arrastra permisos de otras apps/sesiones
    return u.toString();
  }

  async exchangeCode(i: { client: OAuthClient; redirectUri: string; code: string; codeVerifier: string }): Promise<TokenSet> {
    const body = await this.token({ grant_type: 'authorization_code', code: i.code, redirect_uri: i.redirectUri, code_verifier: i.codeVerifier, client_id: i.client.clientId, client_secret: i.client.clientSecret });
    if (!body.access_token || !body.refresh_token) throw new CalendarError('Google no entregó el permiso permanente: vuelve a conectar y acepta todos los permisos', false, true);
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresInSeconds: Number(body.expires_in) || 3600, scopes: (body.scope ?? '').split(/\s+/).filter(Boolean) };
  }

  async accessToken(i: { client: OAuthClient; refreshToken: string }): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const body = await this.token({ grant_type: 'refresh_token', refresh_token: i.refreshToken, client_id: i.client.clientId, client_secret: i.client.clientSecret });
    if (!body.access_token) throw new CalendarError('Google no entregó un acceso válido', true);
    return { accessToken: body.access_token, expiresInSeconds: Number(body.expires_in) || 3600 };
  }

  async accountEmail(i: { accessToken: string }): Promise<string | null> {
    const res = await this.call(this.ep.userinfoUrl, { method: 'GET', headers: { authorization: `Bearer ${i.accessToken}` } });
    await this.assertOk(res);
    const j = (await res.json().catch(() => ({}))) as { email?: unknown };
    return typeof j.email === 'string' && j.email.includes('@') ? j.email : null;
  }

  async createCalendar(i: { accessToken: string; name: string; timeZone: string }): Promise<CalendarInfo> {
    const res = await this.call(`${this.ep.apiBase}/calendars`, { method: 'POST', headers: { authorization: `Bearer ${i.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ summary: i.name, timeZone: i.timeZone }) });
    await this.assertOk(res);
    const j = (await res.json().catch(() => ({}))) as { id?: unknown; summary?: unknown };
    if (typeof j.id !== 'string' || !j.id) throw new CalendarError('Google no devolvió el calendario creado', true);
    return { id: j.id, name: typeof j.summary === 'string' ? j.summary : i.name, primary: false, writable: true };
  }

  async listCalendars(i: { accessToken: string }): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const u = new URL(`${this.ep.apiBase}/users/me/calendarList`);
      u.searchParams.set('maxResults', '100');
      u.searchParams.set('minAccessRole', 'writer'); // solo donde se puede escribir
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await this.call(u.toString(), { method: 'GET', headers: { authorization: `Bearer ${i.accessToken}` } });
      await this.assertOk(res);
      const j = (await res.json().catch(() => ({}))) as { items?: Array<{ id?: unknown; summary?: unknown; summaryOverride?: unknown; primary?: unknown; accessRole?: unknown }>; nextPageToken?: unknown };
      for (const c of j.items ?? []) {
        if (typeof c.id !== 'string' || !c.id) continue;
        const name = typeof c.summaryOverride === 'string' && c.summaryOverride ? c.summaryOverride : typeof c.summary === 'string' ? c.summary : c.id;
        out.push({ id: c.id, name, primary: c.primary === true, writable: c.accessRole === 'owner' || c.accessRole === 'writer' });
      }
      pageToken = typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async revoke(i: { token: string }): Promise<void> {
    const res = await this.call(this.ep.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: i.token }).toString() });
    // 400 «invalid_token»: ya estaba revocado o vencido; para quien desconecta es lo mismo
    if (res.ok || res.status === 400) return;
    await this.assertOk(res);
  }

  async createEvent(i: { accessToken: string; calendarId: string; event: CalendarEventInput }): Promise<CalendarEventRef> {
    const res = await this.call(`${this.ep.apiBase}/calendars/${encodeURIComponent(i.calendarId)}/events`, { method: 'POST', headers: this.json(i.accessToken), body: JSON.stringify(this.eventBody(i.event, true)) });
    if (res.status === 409) throw new CalendarError('Ya existe un evento con ese id', false, false, 'exists');
    await this.assertOk(res);
    const ref = await this.ref(res, i.event.id);
    return { eventId: ref.eventId, etag: ref.etag };
  }

  async updateEvent(i: { accessToken: string; calendarId: string; eventId: string; event: CalendarEventInput }): Promise<CalendarEventRef> {
    const res = await this.call(`${this.ep.apiBase}/calendars/${encodeURIComponent(i.calendarId)}/events/${encodeURIComponent(i.eventId)}`, { method: 'PUT', headers: this.json(i.accessToken), body: JSON.stringify(this.eventBody(i.event, false)) });
    if (res.status === 404 || res.status === 410) throw new CalendarError('El evento ya no existe en Google', false, false, 'gone');
    await this.assertOk(res);
    const ref = await this.ref(res, i.eventId);
    // Un evento que la persona canceló en Google sigue respondiendo 200 con «cancelled»: para nosotros es borrado
    if (ref.cancelled) throw new CalendarError('El evento ya no existe en Google', false, false, 'gone');
    return { eventId: ref.eventId, etag: ref.etag };
  }

  async deleteEvent(i: { accessToken: string; calendarId: string; eventId: string }): Promise<void> {
    const res = await this.call(`${this.ep.apiBase}/calendars/${encodeURIComponent(i.calendarId)}/events/${encodeURIComponent(i.eventId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${i.accessToken}` } });
    if (res.ok || res.status === 404 || res.status === 410) return; // ya no estaba: queda borrado
    await this.assertOk(res);
  }

  // ------------------------------------------------------------------ internos

  private async token(form: Record<string, string>): Promise<TokenBody> {
    const res = await this.call(this.ep.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    const body = (await res.json().catch(() => ({}))) as TokenBody;
    if (res.ok) return body;
    if (res.status >= 500 || res.status === 429) throw new CalendarError('Google no respondió bien. Inténtalo de nuevo en unos minutos', true);
    // invalid_grant: código usado o vencido, o permiso revocado. invalid_client: el ID/secreto de la plataforma está mal.
    if (body.error === 'invalid_client') throw new CalendarError('La aplicación de Google de la plataforma no está bien configurada (ID o secreto de cliente)', false);
    throw new CalendarError('Google rechazó la autorización. Vuelve a conectar', false, true);
  }

  private json(accessToken: string): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  }

  /** El cuerpo del evento: título, descripción y horas. Sin invitados ni teléfonos. */
  private eventBody(e: CalendarEventInput, withId: boolean): Record<string, unknown> {
    return {
      ...(withId ? { id: e.id } : {}),
      summary: e.summary,
      description: e.description,
      start: { dateTime: e.startsAt.toISOString(), timeZone: e.timeZone },
      end: { dateTime: e.endsAt.toISOString(), timeZone: e.timeZone },
      extendedProperties: { private: { sales_smart: '1' } },
    };
  }

  private async ref(res: Response, fallbackId: string): Promise<CalendarEventRef & { cancelled: boolean }> {
    const j = (await res.json().catch(() => ({}))) as { id?: unknown; etag?: unknown; status?: unknown };
    return { eventId: typeof j.id === 'string' && j.id ? j.id : fallbackId, etag: typeof j.etag === 'string' ? j.etag : null, cancelled: j.status === 'cancelled' };
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new CalendarError('No se pudo contactar a Google', true); // el error original podría traer la dirección con datos: no se propaga
    }
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    if (res.status === 401) throw new CalendarError('Google rechazó el acceso: vuelve a conectar', false, true);
    if (res.status === 403) {
      // «La API no está habilitada en el proyecto» no es un permiso que le falte a la persona: es de la plataforma (Google Cloud › APIs y servicios)
      const j = (await res.clone().json().catch(() => ({}))) as { error?: { status?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> } };
      const reasons = [...(j.error?.errors ?? []), ...(j.error?.details ?? [])].map((x) => String(x.reason ?? ''));
      if (reasons.some((r) => r === 'accessNotConfigured' || r === 'SERVICE_DISABLED')) throw new CalendarError('La API de Google Calendar no está habilitada en el proyecto de Google Cloud', false, false, 'api_disabled');
      throw new CalendarError('Falta un permiso en la cuenta de Google. Vuelve a conectar y acepta todos los permisos', false, true);
    }
    if (res.status === 404) throw new CalendarError('Google no encontró el calendario', false);
    if (res.status === 429 || res.status >= 500) throw new CalendarError('Google no respondió bien. Inténtalo de nuevo en unos minutos', true);
    throw new CalendarError('Google rechazó la solicitud', false);
  }
}
