// Contract tests de los adaptadores reales (ADR-37): Resend (correo) y Turnstile (anti-bots), con un `fetch` simulado.
import { describe, expect, it } from 'vitest';
import { MemoryMailProvider } from '../../src/mail/fakes';
import type { MailProvider } from '../../src/mail/ports';
import { ResendMailProvider } from '../../src/mail/resend.provider';
import { invitationMail, ownershipChangeMail, passwordResetMail, verificationMail } from '../../src/mail/templates';
import { FakeCaptchaVerifier } from '../../src/modules/auth/signup/fakes';
import type { CaptchaVerifier } from '../../src/modules/auth/signup/ports';
import { TurnstileVerifier } from '../../src/modules/auth/signup/turnstile.verifier';

const KEY = 're_test_1234567890abcdef';
const SECRET = '1x0000000000000000000000000000000AA';

interface Seen { url: string; init: RequestInit }
function fakeFetch(reply: () => Response | Promise<Response>): { fn: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { fn, seen };
}
const ok = () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const resend = (f: typeof fetch, over: Partial<ConstructorParameters<typeof ResendMailProvider>[0]> = {}) =>
  new ResendMailProvider({ apiKey: KEY, from: 'Sales Smart <no-reply@growthconsulting.digital>', fetchImpl: f, ...over });

describe('ResendMailProvider', () => {
  it('envía el código con la forma exacta que espera Resend: host fijo, POST, clave en Authorization, remitente, destinatario y contenido', async () => {
    const { fn, seen } = fakeFetch(ok);
    await resend(fn).sendVerificationCode({ to: 'ana@empresa.test', code: '483920', expiresInMinutes: 15 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.resend.com/emails');
    expect(seen[0]!.init.method).toBe('POST');
    const h = seen[0]!.init.headers as Record<string, string>;
    expect(h['authorization']).toBe(`Bearer ${KEY}`);
    expect(h['content-type']).toBe('application/json');
    const body = JSON.parse(String(seen[0]!.init.body)) as { from: string; to: string[]; subject: string; html: string; text: string };
    expect(body.from).toBe('Sales Smart <no-reply@growthconsulting.digital>');
    expect(body.to).toEqual(['ana@empresa.test']);
    expect(body.html).toContain('483920');
    expect(body.text).toContain('483920');
    expect(body.text).toContain('15 minutos');
    expect(body.subject).not.toContain('483920'); // el código no va en el asunto (se ve en notificaciones con la pantalla bloqueada)
  });

  it('envía el enlace de restablecimiento en HTML y en texto, y el enlace llega entero (con el fragmento del token)', async () => {
    const { fn, seen } = fakeFetch(ok);
    const url = 'https://app.growthconsulting.digital/reset-password#token=0192f0aa-0000-7000-8000-000000000001.AbCdEf_-123';
    await resend(fn).sendPasswordReset({ to: 'ana@empresa.test', resetUrl: url, expiresInMinutes: 30 });
    const body = JSON.parse(String(seen[0]!.init.body)) as { html: string; text: string; subject: string };
    expect(body.html).toContain(`href="${url}"`);
    expect(body.text).toContain(url);
    expect(body.text).toContain('30 minutos');
    expect(body.subject).toMatch(/contraseña/i);
  });

  it('envía la invitación con el enlace entero, el nombre de la empresa escapado y la vigencia en días', async () => {
    const { fn, seen } = fakeFetch(ok);
    const url = 'https://app.growthconsulting.digital/accept-invite#token=0192f0aa-0000-7000-8000-000000000001.AbCdEf_-123';
    await resend(fn).sendInvitation({ to: 'dueno@empresa.test', organizationName: 'Café <Norte> & Hijos', inviteUrl: url, expiresInDays: 7 });
    const body = JSON.parse(String(seen[0]!.init.body)) as { to: string[]; html: string; text: string; subject: string };
    expect(body.to).toEqual(['dueno@empresa.test']);
    expect(body.html).toContain(`href="${url}"`);
    expect(body.html).toContain('Café &lt;Norte&gt; &amp; Hijos');
    expect(body.html).not.toContain('<Norte>');
    expect(body.text).toContain(url);
    expect(body.text).toContain('7 días');
    expect(body.subject).toContain('Sales Smart');
    expect(body.subject).not.toContain('token');
  });

  it('la invitación rechaza enlaces que no sean http(s) antes de llamar a Resend', async () => {
    const { fn, seen } = fakeFetch(ok);
    await expect(resend(fn).sendInvitation({ to: 'a@b.test', organizationName: 'X', inviteUrl: 'javascript:alert(1)', expiresInDays: 7 })).rejects.toThrow(/http\(s\)/);
    expect(seen).toHaveLength(0);
  });

  it('escapa el HTML y rechaza enlaces que no sean http(s) ANTES de llamar a Resend', async () => {
    const { fn, seen } = fakeFetch(ok);
    const p = resend(fn);
    await p.sendPasswordReset({ to: 'a@b.test', resetUrl: 'https://x.test/r#t="><script>alert(1)</script>', expiresInMinutes: 30 });
    const html = (JSON.parse(String(seen[0]!.init.body)) as { html: string }).html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
    await expect(p.sendPasswordReset({ to: 'a@b.test', resetUrl: 'javascript:alert(1)', expiresInMinutes: 30 })).rejects.toThrow(/http\(s\)/);
    expect(seen).toHaveLength(1); // el segundo nunca llegó a la red
  });

  it('un rechazo de Resend (p. ej. dominio sin verificar) lanza con el estado y el motivo, SIN la clave', async () => {
    const { fn } = fakeFetch(() => json(403, { name: 'validation_error', message: 'The growthconsulting.digital domain is not verified.' }));
    const err = await resend(fn).sendVerificationCode({ to: 'a@b.test', code: '111111', expiresInMinutes: 15 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/403/);
    expect((err as Error).message).toMatch(/not verified/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('un 5xx sin cuerpo JSON también lanza', async () => {
    const { fn } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(resend(fn).sendVerificationCode({ to: 'a@b.test', code: '111111', expiresInMinutes: 15 })).rejects.toThrow(/502/);
  });

  it('un error de red lanza un mensaje genérico (sin URL, cabeceras ni clave)', async () => {
    const boom = (async () => { throw new TypeError(`fetch failed https://api.resend.com/emails authorization: Bearer ${KEY}`); }) as typeof fetch;
    const err = await resend(boom).sendVerificationCode({ to: 'a@b.test', code: '111111', expiresInMinutes: 15 }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Resend: no se pudo conectar');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('respeta el tiempo máximo: una llamada que no responde se corta', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(init.signal?.reason)); })) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(resend(hang, { timeoutMs: 40 }).sendVerificationCode({ to: 'a@b.test', code: '111111', expiresInMinutes: 15 })).rejects.toThrow(/tiempo de espera/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('TurnstileVerifier', () => {
  const tv = (f: typeof fetch) => new TurnstileVerifier({ secret: SECRET, fetchImpl: f });

  it('consulta siteverify con el secreto, el token y la IP; success:true → true', async () => {
    const { fn, seen } = fakeFetch(() => json(200, { success: true, hostname: 'app.growthconsulting.digital' }));
    expect(await tv(fn).verify({ token: 'tok-abc', ip: '203.0.113.9' })).toBe(true);
    expect(seen[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(seen[0]!.init.method).toBe('POST');
    const p = new URLSearchParams(String(seen[0]!.init.body));
    expect(Object.fromEntries(p)).toEqual({ secret: SECRET, response: 'tok-abc', remoteip: '203.0.113.9' });
  });

  it('sin IP no envía remoteip; success:false o un cuerpo raro → false', async () => {
    const a = fakeFetch(() => json(200, { success: true }));
    await tv(a.fn).verify({ token: 'x' });
    expect(new URLSearchParams(String(a.seen[0]!.init.body)).has('remoteip')).toBe(false);
    expect(await tv(fakeFetch(() => json(200, { success: false, 'error-codes': ['invalid-input-response'] })).fn).verify({ token: 'malo' })).toBe(false);
    expect(await tv(fakeFetch(() => json(200, { success: 'true' })).fn).verify({ token: 'x' })).toBe(false); // solo el booleano true cuenta
    expect(await tv(fakeFetch(() => new Response('no json', { status: 200 })).fn).verify({ token: 'x' })).toBe(false);
  });

  it('un token vacío o gigante es inválido y NO se consulta al proveedor', async () => {
    const { fn, seen } = fakeFetch(() => json(200, { success: true }));
    expect(await tv(fn).verify({ token: '' })).toBe(false);
    expect(await tv(fn).verify({ token: 'x'.repeat(2049) })).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('una caída del proveedor LANZA (el llamador falla cerrado y lo registra); nunca devuelve true', async () => {
    await expect(tv(fakeFetch(() => json(500, {})).fn).verify({ token: 'x' })).rejects.toThrow(/500/);
    const boom = (async () => { throw new TypeError(`fetch failed secret=${SECRET}`); }) as typeof fetch;
    const err = await tv(boom).verify({ token: 'x' }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Turnstile: no se pudo conectar');
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('respeta el tiempo máximo', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(init.signal?.reason)); })) as unknown as typeof fetch;
    await expect(new TurnstileVerifier({ secret: SECRET, fetchImpl: hang, timeoutMs: 40 }).verify({ token: 'x' })).rejects.toThrow(/tiempo de espera/);
  });
});

describe('contrato de los puertos: el real y el fake cumplen la misma interfaz', () => {
  const mails: Array<[string, MailProvider]> = [['MemoryMailProvider', new MemoryMailProvider()], ['ResendMailProvider', resend(fakeFetch(ok).fn)]];
  for (const [name, p] of mails) {
    it(`${name}: available=true y ambos envíos se resuelven`, async () => {
      expect(p.available).toBe(true);
      await expect(p.sendVerificationCode({ to: 'a@b.test', code: '123456', expiresInMinutes: 15 })).resolves.toBeUndefined();
      await expect(p.sendPasswordReset({ to: 'a@b.test', resetUrl: 'https://x.test/reset-password#token=t', expiresInMinutes: 30 })).resolves.toBeUndefined();
      await expect(p.sendInvitation({ to: 'a@b.test', organizationName: 'Empresa', inviteUrl: 'https://x.test/accept-invite#token=t', expiresInDays: 7 })).resolves.toBeUndefined();
      await expect(p.sendOwnershipChange({ to: 'a@b.test', organizationName: 'Empresa', agencyName: 'Agencia', previousAgencyName: null })).resolves.toBeUndefined();
    });
  }
  const captchas: Array<[string, CaptchaVerifier, string]> = [['FakeCaptchaVerifier', new FakeCaptchaVerifier(), 'fake-pass'], ['TurnstileVerifier', tvOk(), 'cualquier-token']];
  for (const [name, c, good] of captchas) {
    it(`${name}: available=true, token válido → true y token inválido → false`, async () => {
      expect(c.available).toBe(true);
      expect(await c.verify({ token: good })).toBe(true);
      expect(await c.verify({ token: '' })).toBe(false);
    });
  }
  function tvOk(): TurnstileVerifier {
    return new TurnstileVerifier({ secret: SECRET, fetchImpl: fakeFetch(() => json(200, { success: true })).fn });
  }
});

describe('plantillas', () => {
  it('el correo del código no contiene nada de otros usuarios ni enlaces; el de restablecer tiene un único enlace', () => {
    const v = verificationMail({ to: 'a@b.test', code: '246810', expiresInMinutes: 15 });
    expect(v.html).not.toMatch(/https?:\/\//);
    expect(v.html).not.toContain('a@b.test'); // el destinatario va en el encabezado, no en el cuerpo
    const r = passwordResetMail({ to: 'a@b.test', resetUrl: 'https://x.test/reset-password#token=t', expiresInMinutes: 30 });
    expect(r.html.match(/href="/g)).toHaveLength(1);
  });
  it('la invitación a una AGENCIA lo dice; la de una empresa no menciona agencias', () => {
    const ag = invitationMail({ to: 'a@b.test', organizationName: 'Agencia Uno', kind: 'agency', inviteUrl: 'https://x.test/accept-invite#token=t', expiresInDays: 7 });
    expect(ag.html).toContain('Crearon la agencia');
    expect(ag.text).toContain('Crearon la agencia Agencia Uno');
    const co = invitationMail({ to: 'a@b.test', organizationName: 'Empresa', inviteUrl: 'https://x.test/accept-invite#token=t', expiresInDays: 7 });
    expect(co.html).toContain('Crearon la cuenta de');
    expect(co.html).not.toContain('Crearon la agencia');
  });
  it('la invitación tiene un único enlace y no contiene el correo del destinatario en el cuerpo; 1 día en singular', () => {
    const i = invitationMail({ to: 'dueno@empresa.test', organizationName: 'Empresa', inviteUrl: 'https://x.test/accept-invite#token=t', expiresInDays: 1 });
    expect(i.html.match(/href="/g)).toHaveLength(1);
    expect(i.html).not.toContain('dueno@empresa.test');
    expect(i.text).toContain('1 día');
    expect(i.text).not.toContain('1 días');
  });
  it('el aviso de cambio de administración: nombra a la agencia nueva y a la anterior, o dice «directamente»; escapa el HTML y no lleva enlaces', () => {
    const a = ownershipChangeMail({ to: 'a@b.test', organizationName: 'Café <Norte>', agencyName: 'Agencia & Co', previousAgencyName: 'Vieja' });
    expect(a.html).toContain('Ahora Agencia &amp; Co administra tu cuenta');
    expect(a.html).toContain('Café &lt;Norte&gt;');
    expect(a.html).toContain('en lugar de <b>Vieja</b>');
    expect(a.html).not.toMatch(/https?:\/\/|href=/);
    expect(a.text).toContain('en lugar de Vieja');
    expect(a.subject).toContain('Cambió la administración');
    const d = ownershipChangeMail({ to: 'a@b.test', organizationName: 'Empresa', agencyName: null, previousAgencyName: 'Vieja' });
    expect(d.html).toContain('Administras tu cuenta directamente');
    expect(d.text).toContain('la administras tú directamente');
    expect(d.subject).toContain('directamente');
    expect(d.html).not.toContain('no se hará ningún cambio'); // el pie genérico de «si no fuiste tú» no aplica a un aviso de cambio
  });
  it('minutos de vigencia: se redondean y nunca muestran 0', () => {
    expect(verificationMail({ to: 'a@b.test', code: '1', expiresInMinutes: 0.2 }).text).toContain('1 minutos');
    expect(verificationMail({ to: 'a@b.test', code: '1', expiresInMinutes: 14.6 }).text).toContain('15 minutos');
  });
});
