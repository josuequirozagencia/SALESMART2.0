import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Bóveda de credenciales de terceros (ADR-42, Build Spec §11.4: cifrado de sobre).
 *  - Cada fila lleva su PROPIA clave de datos (DEK, AES-256 aleatoria) con la que se cifra el JSON de secretos; la DEK se envuelve con la clave maestra
 *    (KEK) del servidor. Las dos operaciones son AES-256-GCM con IV aleatorio de 96 bits y etiqueta de 128: cualquier alteración falla al abrir.
 *  - El AAD («servicio/proveedor») ata el contenido a SU fila: copiar el sobre de una fila a otra no se puede abrir.
 *  - La KEK vive solo en el entorno del servidor (nunca en la BD ni en los registros). El llavero admite la vigente y UNA anterior para rotar sin perder
 *    lo ya guardado: se abre con la versión que dice el sobre y se vuelve a sellar con la vigente.
 * Formato: ss1:<versión KEK>:<iv DEK>:<DEK envuelta>:<tag DEK>:<iv datos>:<datos>:<tag datos> (base64url).
 */
export interface VaultKey {
  readonly version: number;
  /** 32 bytes (AES-256). */
  readonly key: Buffer;
}
export interface VaultKeyring {
  readonly current: VaultKey;
  readonly previous?: VaultKey | undefined;
}
export interface VaultConfig {
  readonly current: { readonly version: number; readonly key: string };
  readonly previous: { readonly version: number; readonly key: string } | undefined;
}

/** El sobre no se pudo abrir (clave equivocada, sobre alterado o de otra fila). Nunca incluye datos. */
export class VaultOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultOpenError';
  }
}

const PREFIX = 'ss1';
const b64 = (b: Buffer): string => b.toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');

function gcmSeal(key: Buffer, plain: Buffer, aad: string): { iv: Buffer; data: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv, data, tag: c.getAuthTag() };
}

function gcmOpen(key: Buffer, iv: Buffer, data: Buffer, tag: Buffer, aad: string): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]);
  } catch {
    throw new VaultOpenError('No se pudo abrir el sobre de credenciales');
  }
}

export class CredentialVault {
  constructor(private readonly ring: VaultKeyring) {
    for (const k of [ring.current, ring.previous]) {
      if (k && k.key.length !== 32) throw new Error('La clave maestra de la bóveda debe tener 32 bytes');
    }
    if (ring.previous && ring.previous.version === ring.current.version) throw new Error('Las claves de la bóveda deben tener versiones distintas');
  }

  /** Construye la bóveda desde la configuración validada (o null si no hay clave: guardar credenciales queda deshabilitado). */
  static fromConfig(c: VaultConfig | undefined): CredentialVault | null {
    if (!c) return null;
    return new CredentialVault({
      current: { version: c.current.version, key: Buffer.from(c.current.key, 'base64') },
      previous: c.previous ? { version: c.previous.version, key: Buffer.from(c.previous.key, 'base64') } : undefined,
    });
  }

  get currentVersion(): number {
    return this.ring.current.version;
  }

  /** Cifra los secretos de UNA fila con la clave vigente. */
  seal(secrets: Readonly<Record<string, string>>, aad: string): { sealed: string; keyVersion: number } {
    const dek = randomBytes(32);
    const wrapped = gcmSeal(this.ring.current.key, dek, `${PREFIX}|dek|${aad}`);
    const body = gcmSeal(dek, Buffer.from(JSON.stringify(secrets), 'utf8'), `${PREFIX}|data|${aad}`);
    const sealed = [PREFIX, String(this.ring.current.version), b64(wrapped.iv), b64(wrapped.data), b64(wrapped.tag), b64(body.iv), b64(body.data), b64(body.tag)].join(':');
    return { sealed, keyVersion: this.ring.current.version };
  }

  /** Abre el sobre de UNA fila. Lanza `VaultOpenError` si la clave no es la correcta, el sobre se alteró o pertenece a otra fila. */
  open(sealed: string, aad: string): Record<string, string> {
    const parts = sealed.split(':');
    if (parts.length !== 8 || parts[0] !== PREFIX) throw new VaultOpenError('Formato de sobre desconocido');
    const [, version, dekIv, dekData, dekTag, iv, data, tag] = parts as [string, string, string, string, string, string, string, string];
    const key = this.keyFor(Number(version));
    if (!key) throw new VaultOpenError(`No hay clave maestra para la versión ${version}`);
    const dek = gcmOpen(key.key, unb64(dekIv), unb64(dekData), unb64(dekTag), `${PREFIX}|dek|${aad}`);
    const json = gcmOpen(dek, unb64(iv), unb64(data), unb64(tag), `${PREFIX}|data|${aad}`).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new VaultOpenError('Contenido del sobre ilegible');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) throw new VaultOpenError('Contenido del sobre inválido');
    return parsed as Record<string, string>;
  }

  /** ¿El sobre está envuelto con una clave que ya no es la vigente? (hay que volver a sellarlo). */
  needsRewrap(keyVersion: number | null): boolean {
    return keyVersion !== null && keyVersion !== this.ring.current.version;
  }

  private keyFor(version: number): VaultKey | undefined {
    if (this.ring.current.version === version) return this.ring.current;
    if (this.ring.previous?.version === version) return this.ring.previous;
    return undefined;
  }
}
