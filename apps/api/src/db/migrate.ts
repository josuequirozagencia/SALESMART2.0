/* Migraciones (rol app_owner; nunca desde la API). El CLI está en migrate-cli.ts */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'node:path';

export async function runMigrations(ownerUrl: string, folder = path.join(__dirname, 'migrations')): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}
