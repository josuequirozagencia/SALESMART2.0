import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDisposableDomains, parseDomainList } from '../../src/db/load-disposable-domains';
import { requireDb } from '../support/harness';

const FILE = path.resolve(__dirname, '../../../../data/disposable_email_blocklist.conf');

describe('lista de dominios desechables', () => {
  it('parseDomainList normaliza, deduplica y descarta líneas inválidas', () => {
    const r = parseDomainList('# c\nMailinator.com\n\nmailinator.com\nmal formado\nsin-punto\n a.b-c.test \n');
    expect(r.domains.sort()).toEqual(['a.b-c.test', 'mailinator.com']);
    expect(r.skipped).toBe(2);
  });
  it('el archivo versionado contiene miles de dominios válidos (ninguno descartado) y dominios conocidos', () => {
    const r = parseDomainList(readFileSync(FILE, 'utf8'));
    expect(r.domains.length).toBeGreaterThan(3000);
    expect(r.skipped).toBe(0);
    expect(r.domains).toContain('mailinator.com');
  });
  describe('carga con el rol propietario', () => {
    const info = requireDb();
    let admin: Client;
    beforeAll(async () => { admin = new Client({ connectionString: info.adminDbUrl }); await admin.connect(); await admin.query('TRUNCATE disposable_domains'); });
    afterAll(async () => { await admin.query('TRUNCATE disposable_domains'); await admin.end(); });
    it('es idempotente: la segunda carga no inserta nada', async () => {
      const first = await loadDisposableDomains(info.ownerUrl, FILE);
      expect(first.inserted).toBe(first.read);
      expect((await admin.query('SELECT count(*)::int AS n FROM disposable_domains')).rows[0].n).toBe(first.read);
      expect((await loadDisposableDomains(info.ownerUrl, FILE)).inserted).toBe(0);
    });
  });
});
