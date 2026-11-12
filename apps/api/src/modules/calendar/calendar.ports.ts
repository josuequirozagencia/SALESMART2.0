/**
 * Puerto del calendario (v11 Pista G, ADR-67). Ningún módulo importa un cliente HTTP de Google: solo este contrato (adaptadores, CLAUDE.md). La aplicación de Google (ID y secreto de cliente) es de la
 * PLATAFORMA y llega en cada llamada; el token de cada empresa también: el adaptador no guarda ninguno. En esta rebanada (67a) el puerto cubre conectar; crear, mover y borrar eventos llegan en 67b.
 */

/** La aplicación OAuth de la plataforma (se carga en Proveedores › Calendario › Google; nunca sale del servidor). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Lo que Google entrega al canjear el código de autorización. `scopes`: los que la persona SÍ concedió (puede desmarcar alguno). */
export interface TokenSet {
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

/** Lo que se manda a Google de una cita: título, horas y un enlace. Nunca teléfono, correo ni invitados (ADR-67). */
export interface CalendarEventInput {
  /** Id del evento en Google (5–1024 caracteres de a-v y 0-9): determinista a partir de la cita. */
  id: string;
  summary: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  /** Zona horaria de la empresa (IANA). */
  timeZone: string;
}

export interface CalendarEventRef {
  eventId: string;
  etag: string | null;
}

export interface CalendarInfo {
  id: string;
  name: string;
  /** El calendario principal de la cuenta (el del propio correo). */
  primary: boolean;
  /** La cuenta puede escribir eventos ahí. */
  writable: boolean;
}

/** Fallo de una llamada a Google. `credentials`: el token/código ya no sirve (revocado, vencido, `invalid_grant`). `retryable`: red, 5xx o límite. El mensaje NO lleva secretos. */
export class CalendarError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly credentials = false,
    /** Causa conocida: `api_disabled` = la API de Google Calendar no está habilitada en el proyecto de Google Cloud; `exists` = ya hay un evento con ese id (409); `gone` = el evento ya no existe en Google (404/410). */
    readonly kind?: 'api_disabled' | 'exists' | 'gone',
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

export interface CalendarProvider {
  /** `none` = sin adaptador configurado. */
  readonly kind: 'none' | 'fake' | 'google';
  /** La dirección de Google a la que se manda a la persona a autorizar (offline, con consentimiento y PKCE `S256`). */
  authorizeUrl(i: { client: OAuthClient; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string }): string;
  /** Canjea el código (con el verificador PKCE). Exige que Google entregue un refresh token. */
  exchangeCode(i: { client: OAuthClient; redirectUri: string; code: string; codeVerifier: string }): Promise<TokenSet>;
  /** Un access token nuevo a partir del refresh token. `invalid_grant` ⇒ `CalendarError.credentials`. */
  accessToken(i: { client: OAuthClient; refreshToken: string }): Promise<{ accessToken: string; expiresInSeconds: number }>;
  /** El correo de la cuenta que autorizó (para mostrarlo enmascarado). */
  accountEmail(i: { accessToken: string }): Promise<string | null>;
  /** Crea un calendario secundario propio de la aplicación (modo `own`). */
  createCalendar(i: { accessToken: string; name: string; timeZone: string }): Promise<CalendarInfo>;
  /** Los calendarios de la cuenta (modo `existing`; exige el permiso de la lista de calendarios). */
  listCalendars(i: { accessToken: string }): Promise<CalendarInfo[]>;
  /** Crea un evento con el id indicado (determinista: reintentar no duplica). Si ya existe, `CalendarError.kind === 'exists'`. */
  createEvent(i: { accessToken: string; calendarId: string; event: CalendarEventInput }): Promise<CalendarEventRef>;
  /** Reemplaza los datos del evento. Si Google ya no lo tiene (o lo canceló), `CalendarError.kind === 'gone'`. */
  updateEvent(i: { accessToken: string; calendarId: string; eventId: string; event: CalendarEventInput }): Promise<CalendarEventRef>;
  /** Borra el evento. Que ya no exista cuenta como borrado (idempotente). */
  deleteEvent(i: { accessToken: string; calendarId: string; eventId: string }): Promise<void>;
  /** Revoca el token en Google (al desconectar). Un token que ya no existe cuenta como revocado. */
  revoke(i: { token: string }): Promise<void>;
}

export const CALENDAR_PROVIDER = Symbol('CALENDAR_PROVIDER');

/** Sin adaptador configurado (`CALENDAR_PROVIDER=none`): todo falla de forma clara y la pantalla dice que no está disponible. */
export class NoCalendarProvider implements CalendarProvider {
  readonly kind = 'none' as const;
  private fail(): never {
    throw new CalendarError('El calendario no está configurado en el servidor', false);
  }
  authorizeUrl(): string {
    return this.fail();
  }
  exchangeCode(): Promise<TokenSet> {
    return this.fail();
  }
  accessToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return this.fail();
  }
  accountEmail(): Promise<string | null> {
    return this.fail();
  }
  createCalendar(): Promise<CalendarInfo> {
    return this.fail();
  }
  listCalendars(): Promise<CalendarInfo[]> {
    return this.fail();
  }
  revoke(): Promise<void> {
    return this.fail();
  }
  createEvent(): Promise<CalendarEventRef> {
    return this.fail();
  }
  updateEvent(): Promise<CalendarEventRef> {
    return this.fail();
  }
  deleteEvent(): Promise<void> {
    return this.fail();
  }
}

/** Los alcances de Google que usa cada modo (ADR-67). `userinfo.email` solo sirve para reconocer la cuenta. El modo `own` pide ÚNICAMENTE alcances no sensibles. */
export const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
export const SCOPE_APP_CALENDAR = 'https://www.googleapis.com/auth/calendar.app.created';
export const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
export const SCOPE_CALENDAR_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

export type CalendarMode = 'own' | 'existing';
export const MODE_SCOPES: Readonly<Record<CalendarMode, readonly string[]>> = {
  own: [SCOPE_EMAIL, SCOPE_APP_CALENDAR],
  existing: [SCOPE_EMAIL, SCOPE_EVENTS, SCOPE_CALENDAR_LIST],
};
