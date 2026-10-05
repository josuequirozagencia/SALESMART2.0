/* Carga de la lista de dominios desechables (rol app_owner; nunca desde la API, que solo tiene SELECT). */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const DOMAIN_RE = /^[a-z0-9.-]+$/;

/** Una línea = un dominio. Ignora vacías y comentarios (#); normaliza; descarta lo que no cumpla el CHECK de la tabla. */
export function parseDomainList(text: string): { domains: string[]; skipped: number } {
  const set = new Set<string>();
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (line === '' || line.startsWith('#')) continue;
    if (DOMAIN_RE.test(line) && line.includes('.') && line.length <= 253) set.add(line);
    else skipped++;
  }
  return { domains: [...set], skipped };
}

/** Idempotente: ON CONFLICT DO NOTHING. Devuelve cuántas filas nuevas se insertaron. */
export async function loadDisposableDomains(ownerUrl: string, file: string): Promise<{ read: number; inserted: number; skipped: number }> {
  const { domains, skipped } = parseDomainList(readFileSync(file, 'utf8'));
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const r = await pool.query('INSERT INTO disposable_domains(domain) SELECT unnest($1::text[]) ON CONFLICT (domain) DO NOTHING', [domains]);
    return { read: domains.length, inserted: r.rowCount ?? 0, skipped };
  } finally {
    await pool.end();
  }
}
