import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialVault, VaultOpenError } from '../../src/modules/platform/providers/credential-vault';

// ADR-42: cifrado de sobre de las credenciales de proveedores. Función pura (sin BD).
const key = (v: number) => ({ version: v, key: randomBytes(32) });
const secrets = { api_key: 'sk-test-1234567890abcdef', auth_token: 'tok_ñ_€_ü' };

describe('CredentialVault', () => {
  it('sella y abre (ida y vuelta), incluidos caracteres no ASCII', () => {
    const v = new CredentialVault({ current: key(1) });
    const { sealed, keyVersion } = v.seal(secrets, 'text_ai/openai');
    expect(keyVersion).toBe(1);
    expect(v.open(sealed, 'text_ai/openai')).toEqual(secrets);
  });

  it('el sobre NO contiene el secreto en claro ni es igual al sellar dos veces (IV y clave de datos aleatorios)', () => {
    const v = new CredentialVault({ current: key(1) });
    const a = v.seal(secrets, 'x/y').sealed;
    const b = v.seal(secrets, 'x/y').sealed;
    expect(a).not.toBe(b);
    for (const s of [a, b]) {
      expect(s).not.toContain(secrets.api_key);
      expect(Buffer.from(s.split(':').slice(2).join(''), 'base64url').toString('latin1')).not.toContain('api_key');
      expect(s.startsWith('ss1:1:')).toBe(true);
    }
  });

  it('está atado a SU fila: el mismo sobre no se abre con otro servicio/proveedor', () => {
    const v = new CredentialVault({ current: key(1) });
    const { sealed } = v.seal(secrets, 'text_ai/openai');
    expect(() => v.open(sealed, 'text_ai/gemini')).toThrow(VaultOpenError);
    expect(() => v.open(sealed, 'voice_ai/openai')).toThrow(VaultOpenError);
  });

  it('cualquier alteración del sobre falla (cada parte autenticada)', () => {
    const v = new CredentialVault({ current: key(1) });
    const parts = v.seal(secrets, 'a/b').sealed.split(':');
    for (let i = 2; i < parts.length; i++) {
      const bad = [...parts];
      const raw = Buffer.from(bad[i]!, 'base64url');
      raw[0] = raw[0]! ^ 0x01;
      bad[i] = raw.toString('base64url');
      expect(() => v.open(bad.join(':'), 'a/b'), `parte ${i}`).toThrow(VaultOpenError);
    }
    expect(() => v.open('basura', 'a/b')).toThrow(VaultOpenError);
    expect(() => v.open(parts.slice(0, 7).join(':'), 'a/b')).toThrow(VaultOpenError);
    expect(() => v.open(['xx1', ...parts.slice(1)].join(':'), 'a/b')).toThrow(VaultOpenError);
  });

  it('con otra clave maestra no se abre (y el error no revela nada)', () => {
    const a = new CredentialVault({ current: key(1) });
    const b = new CredentialVault({ current: key(1) });
    const { sealed } = a.seal(secrets, 'a/b');
    let msg = '';
    try {
      b.open(sealed, 'a/b');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('No se pudo abrir el sobre de credenciales');
    expect(msg).not.toContain(secrets.api_key);
  });

  it('rotación: abre lo sellado con la clave anterior, sella con la vigente y marca qué hay que re-envolver', () => {
    const old = key(1);
    const before = new CredentialVault({ current: old });
    const legacy = before.seal(secrets, 'a/b');
    const cur = key(2);
    const rotated = new CredentialVault({ current: cur, previous: old });
    expect(rotated.open(legacy.sealed, 'a/b')).toEqual(secrets);
    expect(rotated.needsRewrap(legacy.keyVersion)).toBe(true);
    const fresh = rotated.seal(secrets, 'a/b');
    expect(fresh.keyVersion).toBe(2);
    expect(rotated.needsRewrap(fresh.keyVersion)).toBe(false);
    expect(rotated.needsRewrap(null)).toBe(false);
    // sin la clave anterior, lo viejo ya no se abre
    const noPrev = new CredentialVault({ current: cur });
    expect(() => noPrev.open(legacy.sealed, 'a/b')).toThrow(VaultOpenError);
  });

  it('valida su llavero: 32 bytes y versiones distintas; fromConfig sin clave devuelve null', () => {
    expect(() => new CredentialVault({ current: { version: 1, key: randomBytes(16) } })).toThrow(/32 bytes/);
    const k = key(1);
    expect(() => new CredentialVault({ current: k, previous: { version: 1, key: randomBytes(32) } })).toThrow(/versiones distintas/);
    expect(CredentialVault.fromConfig(undefined)).toBeNull();
    const v = CredentialVault.fromConfig({ current: { version: 3, key: randomBytes(32).toString('base64') }, previous: undefined });
    expect(v?.currentVersion).toBe(3);
  });
});
