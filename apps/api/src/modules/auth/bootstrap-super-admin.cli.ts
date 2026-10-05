/* CLI de bootstrap del primer super_admin. Imprime la contraseña generada UNA sola vez por stdout. */
import { loadConfig } from '../../config';
import { Database } from '../../db';
import { Argon2idHasher } from '../../security';
import { bootstrapSuperAdmin } from './bootstrap-super-admin';

async function main(): Promise<void> {
  const email = process.env['BOOTSTRAP_SUPER_ADMIN_EMAIL'];
  if (!email) throw new Error('define BOOTSTRAP_SUPER_ADMIN_EMAIL');
  const db = Database.create(loadConfig(process.env)); // sin logger: nada de este flujo se registra
  try {
    const r = await bootstrapSuperAdmin(db, new Argon2idHasher(), { email });
    if (!r.created) {
      process.stdout.write('bootstrap:super-admin — ya existe un super_admin; no se hizo ningún cambio\n');
      return;
    }
    process.stdout.write(`super_admin creado: ${r.email}\nContraseña inicial (se muestra UNA vez; cámbiala al primer ingreso):\n${r.password}\n`);
  } finally {
    await db.close();
  }
}
main().catch((e: unknown) => {
  process.stderr.write(`bootstrap:super-admin ERROR: ${e instanceof Error ? e.message : 'fallo desconocido'}\n`);
  process.exitCode = 1;
});
