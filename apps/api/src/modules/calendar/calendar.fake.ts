import { createHash } from 'node:crypto';
import { CalendarError, type CalendarInfo, type CalendarProvider, type OAuthClient, type TokenSet } from './calendar.ports';

/** Lo que el fake «hizo» en Google, en orden (las pruebas lo leen). */
export type FakeCalendarCall =
  | { kind: 'authorizeUrl'; scopes: readonly string[]; state: string }
  | { kind: 'exchangeCode'; code: string }
  | { kind: 'accessToken' }
  | { kind: 'accountEmail' }
  | { kind: 'createCalendar'; name: string; timeZone: string }
  | { kind: 'listCalendars' }
  | { kind: 'revoke'; token: string };

/**
 * Fake del calendario para pruebas. Código válido: `good` (o `good-<n>`); cualquier otro ⇒ rechazo. Verifica PKCE de verdad (el verificador debe corresponder al desafío de la dirección que se
 * generó). Debe pasar el mismo contract test que el adaptador real.
 */
export class FakeCalendarProvider implements CalendarProvider {
  readonly kind = 'fake' as const;
  readonly calls: FakeCalendarCall[] = [];
  /** Alcances que «concede» la persona al canjear el código (las pruebas los recortan para simular que desmarcó alguno). Si es null, concede los pedidos. */
  grantedScopes: string[] | null = null;
  email: string | null = 'ana.perez@example.com';
  calendars: CalendarInfo[] = [
    { id: 'primary-cal', name: 'ana.perez@example.com', primary: true, writable: true },
    { id: 'ventas-cal', name: 'Ventas', primary: false, writable: true },
  ];
  /** Los refresh tokens que «siguen vigentes». */
  readonly liveRefreshTokens = new Set<string>();
  /** Si es true, Google «no entrega» refresh token. */
  withoutRefreshToken = false;
  private lastRequested: readonly string[] = [];
  private issued = new Set<string>();
  private used = new Set<string>();
  private lastChallenge = '';
  private failures: CalendarError[] = [];
  private n = 0;

  /** Un código de autorización de un solo uso (lo que Google entrega a la persona al aprobar). */
  issueCode(): string {
    this.n += 1;
    const code = `good-${this.n}`;
    this.issued.add(code);
    return code;
  }

  /** La próxima llamada a Google falla con este error. */
  failNext(e: CalendarError): void {
    this.failures.push(e);
  }

  private maybeFail(): void {
    const f = this.failures.shift();
    if (f) throw f;
  }

  authorizeUrl(i: { client: OAuthClient; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string }): string {
    this.calls.push({ kind: 'authorizeUrl', scopes: i.scopes, state: i.state });
    this.lastRequested = i.scopes;
    this.lastChallenge = i.codeChallenge;
    const u = new URL('https://fake-google.test/o/oauth2/v2/auth');
    u.searchParams.set('client_id', i.client.clientId);
    u.searchParams.set('redirect_uri', i.redirectUri);
    u.searchParams.set('scope', i.scopes.join(' '));
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
  }

  async exchangeCode(i: { client: OAuthClient; redirectUri: string; code: string; codeVerifier: string }): Promise<TokenSet> {
    await Promise.resolve();
    this.calls.push({ kind: 'exchangeCode', code: i.code });
    this.maybeFail();
    // `good` es un código siempre válido (comodidad para las pruebas); los de `issueCode()` valen UNA sola vez, como los de Google
    const valid = i.code === 'good' || (this.issued.has(i.code) && !this.used.has(i.code));
    this.used.add(i.code);
    if (!valid) throw new CalendarError('Google rechazó la autorización. Vuelve a conectar', false, true);
    const challenge = createHash('sha256').update(i.codeVerifier).digest('base64url');
    if (challenge !== this.lastChallenge) throw new CalendarError('Google rechazó la autorización. Vuelve a conectar', false, true);
    if (this.withoutRefreshToken) throw new CalendarError('Google no entregó el permiso permanente: vuelve a conectar y acepta todos los permisos', false, true);
    this.n += 1;
    const refreshToken = `refresh-token-${this.n}`;
    this.liveRefreshTokens.add(refreshToken);
    return { accessToken: `access-token-${this.n}`, refreshToken, expiresInSeconds: 3600, scopes: this.grantedScopes ?? [...this.lastRequested] };
  }

  async accessToken(i: { client: OAuthClient; refreshToken: string }): Promise<{ accessToken: string; expiresInSeconds: number }> {
    await Promise.resolve();
    this.calls.push({ kind: 'accessToken' });
    this.maybeFail();
    if (!this.liveRefreshTokens.has(i.refreshToken)) throw new CalendarError('Google rechazó la autorización. Vuelve a conectar', false, true);
    return { accessToken: `access-for-${i.refreshToken}`, expiresInSeconds: 3600 };
  }

  async accountEmail(): Promise<string | null> {
    await Promise.resolve();
    this.calls.push({ kind: 'accountEmail' });
    this.maybeFail();
    return this.email;
  }

  async createCalendar(i: { accessToken: string; name: string; timeZone: string }): Promise<CalendarInfo> {
    await Promise.resolve();
    this.calls.push({ kind: 'createCalendar', name: i.name, timeZone: i.timeZone });
    this.maybeFail();
    this.n += 1;
    const cal = { id: `created-cal-${this.n}`, name: i.name, primary: false, writable: true };
    this.calendars.push(cal);
    return cal;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await Promise.resolve();
    this.calls.push({ kind: 'listCalendars' });
    this.maybeFail();
    return this.calendars.map((c) => ({ ...c }));
  }

  async revoke(i: { token: string }): Promise<void> {
    await Promise.resolve();
    this.calls.push({ kind: 'revoke', token: i.token });
    this.maybeFail();
    this.liveRefreshTokens.delete(i.token);
  }
}
