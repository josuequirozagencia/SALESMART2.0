import { randomUUID } from 'node:crypto';
import { StorageError, type StorageAdapter, type StorageErrorCode } from './storage.port';

/**
 * «Probar conexión» del almacenamiento (ADR-42, diferido hasta ahora): sube un archivo de prueba, lo lee de vuelta, genera una URL firmada y lo borra. Así un endpoint o una llave mal escritos se descubren al
 * guardar la configuración y no cuando un cliente intenta subir un archivo. Solo lo ve el Súper Admin: el detalle técnico (qué respondió el almacenamiento) es seguro, pero no es para clientes.
 */
export interface ProbeStep {
  key: 'upload' | 'download' | 'url' | 'delete';
  label: string;
  ok: boolean;
  /** Lo que se le muestra a la persona cuando el paso falla. */
  message: string | null;
  /** Qué respondió realmente el almacenamiento (sin claves): para diagnosticar. */
  detail: string | null;
}

export interface ProbeResult {
  ok: boolean;
  provider: 's3' | 'fake';
  steps: ProbeStep[];
  /** Qué revisar, en palabras claras, según el error. */
  hint: string | null;
  checked_at: string;
}

const LABELS: Record<ProbeStep['key'], string> = {
  upload: 'Subir un archivo de prueba',
  download: 'Leerlo de vuelta',
  url: 'Generar una URL firmada',
  delete: 'Borrar el archivo de prueba',
};

/** Qué revisar según el error. Pura: se prueba sin almacenamiento. */
export function storageHint(code: StorageErrorCode, message: string, detail: string | null): string | null {
  const d = detail ?? '';
  if (/EPROTO|handshake|ENOTFOUND|certificate|ERR_SSL|SSL routines|self.signed|UNABLE_TO_VERIFY/i.test(d)) {
    return 'No se pudo abrir una conexión segura con el Endpoint. Revisa que sea exactamente la URL «S3 API» de tu cuenta de R2: https://<ID de cuenta>.r2.cloudflarestorage.com, con el ID de cuenta real, sin barra final y sin el nombre del bucket.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|timeout|aborted/i.test(d)) return 'El Endpoint no respondió a tiempo: revisa la dirección y que el servicio esté disponible.';
  if (code === 'not_configured') {
    if (/bucket/i.test(message)) return 'Revisa el nombre del bucket y que el token tenga acceso a él (permiso «Object Read & Write», limitado a ese bucket).';
    if (/credenciales/i.test(message)) return 'Revisa el ID de la clave y la clave secreta: son el «Access Key ID» y el «Secret Access Key» del token de R2, no el «Token value».';
    return 'Falta configurar el almacenamiento: guarda el endpoint, la región, el bucket y las llaves, y márcalo «En uso».';
  }
  if (code === 'not_found') return 'Revisa el Endpoint y el nombre del bucket.';
  if (/http=5\d\d/.test(d)) return 'El almacenamiento está fallando de su lado: vuelve a intentarlo en unos minutos.';
  return null;
}

/** Ejecuta la prueba contra el almacenamiento en uso. Cada paso se registra; si falla la subida no se intenta lo demás. Siempre intenta dejar limpio el archivo de prueba. */
export async function probeStorage(storage: StorageAdapter, now = new Date()): Promise<ProbeResult> {
  const key = `_probe/${randomUUID()}.txt`;
  const body = Buffer.from(`prueba de conexión ${now.toISOString()}`);
  const steps: ProbeStep[] = [];
  let hint: string | null = null;

  const run = async (k: ProbeStep['key'], fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      steps.push({ key: k, label: LABELS[k], ok: true, message: null, detail: null });
      return true;
    } catch (e) {
      const err = e instanceof StorageError ? e : new StorageError('unavailable', 'El almacenamiento no respondió');
      steps.push({ key: k, label: LABELS[k], ok: false, message: err.message, detail: err.detail });
      hint ??= storageHint(err.code, err.message, err.detail);
      return false;
    }
  };

  let uploaded = false;
  if (await run('upload', async () => { await storage.put(key, body, 'text/plain'); uploaded = true; })) {
    await run('download', async () => {
      const back = await storage.get(key);
      if (!back.equals(body)) throw new StorageError('unavailable', 'Lo que se leyó no coincide con lo que se subió');
    });
    await run('url', async () => {
      const url = await storage.signedUrl(key, { expiresInSeconds: 60, contentType: 'text/plain', disposition: 'attachment', filename: 'prueba.txt' });
      if (!/^https?:\/\//.test(url)) throw new StorageError('unavailable', 'No se pudo generar la URL firmada');
    });
  }
  // Se limpia siempre que se haya llegado a subir algo, aunque un paso intermedio haya fallado
  if (uploaded) await run('delete', () => storage.delete(key));

  return { ok: steps.length === 4 && steps.every((s) => s.ok), provider: storage.name, steps, hint, checked_at: now.toISOString() };
}
