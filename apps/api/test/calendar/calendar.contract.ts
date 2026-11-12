import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { CalendarError, SCOPE_APP_CALENDAR, SCOPE_EMAIL, type CalendarProvider, type OAuthClient } from '../../src/modules/calendar';

export const CLIENT: OAuthClient = { clientId: 'cliente-de-prueba.example.test', clientSecret: 'secreto-de-cliente-de-prueba' };
export const REDIRECT = 'https://app.ejemplo.test/v1/integrations/google-calendar/callback';
const SCOPES = [SCOPE_EMAIL, SCOPE_APP_CALENDAR];

/** Lo que cada adaptador aporta al contrato: su proveedor y cómo «aprueba» una persona la pantalla de Google (devuelve un código válido para esa dirección). */
export interface ContractHarness {
  provider: CalendarProvider;
  approve: (authorizeUrl: URL) => Promise<string>;
}

const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const rejected = (e: unknown): e is CalendarError => e instanceof CalendarError;

/**
 * Contract test del puerto `CalendarProvider` (CLAUDE.md: cada adaptador tiene fake y contract test). Lo cumplen el fake y el adaptador de Google (que se prueba contra un servidor simulado).
 */
export async function calendarProviderContract(make: () => Promise<ContractHarness>): Promise<void> {
  const { provider, approve } = await make();
  const verifier = 'v'.repeat(43);

  // 1) la dirección de autorización lleva todo lo que Google exige para un flujo seguro y sin conexión
  const url = new URL(provider.authorizeUrl({ client: CLIENT, redirectUri: REDIRECT, scopes: SCOPES, state: 'estado-firmado', codeChallenge: s256(verifier) }));
  expect(url.searchParams.get('client_id')).toBe(CLIENT.clientId);
  expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('estado-firmado');
  expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([...SCOPES].sort());
  expect(url.searchParams.get('code_challenge')).toBe(s256(verifier));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('prompt')).toBe('consent');
  expect(url.toString()).not.toContain(CLIENT.clientSecret); // el secreto nunca viaja por el navegador

  // 2) un código inválido, o el verificador PKCE equivocado, es un rechazo de credenciales (no un error pasajero) y no revela nada
  const bad = await provider.exchangeCode({ client: CLIENT, redirectUri: REDIRECT, code: 'codigo-inventado', codeVerifier: verifier }).catch((e: unknown) => e);
  expect(rejected(bad)).toBe(true);
  expect(bad).toMatchObject({ credentials: true, retryable: false });
  expect((bad as CalendarError).message).not.toContain('codigo-inventado');
  const code = await approve(url);
  const wrongVerifier = await provider.exchangeCode({ client: CLIENT, redirectUri: REDIRECT, code, codeVerifier: 'x'.repeat(43) }).catch((e: unknown) => e);
  expect(wrongVerifier).toMatchObject({ credentials: true });

  // 3) con el código y el verificador correctos entrega el permiso permanente y los alcances concedidos
  const code2 = await approve(url);
  const tokens = await provider.exchangeCode({ client: CLIENT, redirectUri: REDIRECT, code: code2, codeVerifier: verifier });
  expect(tokens.refreshToken.length).toBeGreaterThan(5);
  expect(tokens.accessToken.length).toBeGreaterThan(5);
  expect(tokens.expiresInSeconds).toBeGreaterThan(0);
  expect([...tokens.scopes].sort()).toEqual([...SCOPES].sort());

  // 4) un código no se puede usar dos veces
  const again = await provider.exchangeCode({ client: CLIENT, redirectUri: REDIRECT, code: code2, codeVerifier: verifier }).catch((e: unknown) => e);
  expect(again).toMatchObject({ credentials: true });

  // 5) el permiso permanente da accesos nuevos; uno inventado es rechazo de credenciales
  const access = await provider.accessToken({ client: CLIENT, refreshToken: tokens.refreshToken });
  expect(access.accessToken.length).toBeGreaterThan(5);
  const noRefresh = await provider.accessToken({ client: CLIENT, refreshToken: 'permiso-inventado' }).catch((e: unknown) => e);
  expect(noRefresh).toMatchObject({ credentials: true, retryable: false });

  // 6) cuenta, crear calendario y listar
  expect(await provider.accountEmail({ accessToken: access.accessToken })).toMatch(/^[^@\s]+@[^@\s]+$/);
  const created = await provider.createCalendar({ accessToken: access.accessToken, name: 'Sales Smart · Barbería Norte', timeZone: 'America/Guayaquil' });
  expect(created.id.length).toBeGreaterThan(0);
  expect(created.name).toBe('Sales Smart · Barbería Norte');
  expect(created.writable).toBe(true);
  const all = await provider.listCalendars({ accessToken: access.accessToken });
  expect(all.length).toBeGreaterThan(0);
  expect(all.some((c) => c.id === created.id)).toBe(true);
  for (const c of all) expect(c).toEqual({ id: expect.any(String), name: expect.any(String), primary: expect.any(Boolean), writable: expect.any(Boolean) });

  // 6b) eventos: crear con id propio (no se duplica), actualizar, y borrar es idempotente; lo que ya no existe se avisa con «gone»
  const calendarId = created.id;
  const event = { id: 'a'.repeat(32), summary: 'Corte · Ana · Carla', description: 'Cita agendada en Sales Smart.', startsAt: new Date('2030-01-10T15:00:00Z'), endsAt: new Date('2030-01-10T15:30:00Z'), timeZone: 'America/Guayaquil' };
  const ref = await provider.createEvent({ accessToken: access.accessToken, calendarId, event });
  expect(ref.eventId).toBe(event.id);
  const dup = await provider.createEvent({ accessToken: access.accessToken, calendarId, event }).catch((e: unknown) => e);
  expect(dup).toMatchObject({ kind: 'exists', credentials: false, retryable: false });
  const moved = await provider.updateEvent({ accessToken: access.accessToken, calendarId, eventId: event.id, event: { ...event, summary: 'Corte · Ana · Eva', startsAt: new Date('2030-01-10T16:00:00Z'), endsAt: new Date('2030-01-10T16:30:00Z') } });
  expect(moved.eventId).toBe(event.id);
  await provider.deleteEvent({ accessToken: access.accessToken, calendarId, eventId: event.id });
  await provider.deleteEvent({ accessToken: access.accessToken, calendarId, eventId: event.id }); // ya no existía: sigue sin fallar
  const gone = await provider.updateEvent({ accessToken: access.accessToken, calendarId, eventId: event.id, event }).catch((e: unknown) => e);
  expect(gone).toMatchObject({ kind: 'gone', credentials: false, retryable: false });

  // 7) revocar es idempotente: dejarlo sin efecto y volver a revocarlo no falla
  await provider.revoke({ token: tokens.refreshToken });
  await provider.revoke({ token: tokens.refreshToken });
  const afterRevoke = await provider.accessToken({ client: CLIENT, refreshToken: tokens.refreshToken }).catch((e: unknown) => e);
  expect(afterRevoke).toMatchObject({ credentials: true });
}
