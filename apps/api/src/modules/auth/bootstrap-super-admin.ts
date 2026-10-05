import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { organizationMembers, organizations, users } from '../../db';
import type { PasswordHasher } from '../../security';

export interface BootstrapInput {
  /** Email del primer super_admin (se normaliza: trim + minúsculas). */
  email: string;
  /** Nombre de la organización de plataforma (solo si aún no existe). */
  platformOrgName?: string;
  /** Inyectable para pruebas; por defecto 24 bytes aleatorios en base64url. */
  generatePassword?: () => string;
}

export type BootstrapResult =
  | { created: true; userId: string; organizationId: string; email: string; password: string }
  | { created: false; reason: 'super_admin_exists' };

export class BootstrapError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCK_KEY = 'sales-smart:bootstrap:super_admin';

export const generateInitialPassword = (): string => randomBytes(24).toString('base64url');

/**
 * Crea el PRIMER super_admin de la plataforma (ADR-25). Idempotente y seguro ante concurrencia:
 *  - lock de transacción (pg_advisory_xact_lock) → solo una ejecución simultánea crea; las demás ven el resultado;
 *  - si ya existe un super_admin activo NO hace nada ni devuelve contraseña;
 *  - si el email ya pertenece a otro usuario, falla (no se "adopta" una cuenta existente);
 *  - la contraseña es única y aleatoria, se devuelve UNA vez y solo existe su hash Argon2id en la BD.
 * El llamador (CLI) es responsable de mostrar la contraseña por stdout y NUNCA registrarla en el logger.
 */
export async function bootstrapSuperAdmin(db: Database, hasher: PasswordHasher, input: BootstrapInput): Promise<BootstrapResult> {
  const email = input.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) throw new BootstrapError('email inválido');
  const password = (input.generatePassword ?? generateInitialPassword)();
  const passwordHash = await hasher.hash(password); // fuera de la transacción: no retiene el lock durante el cálculo

  return db.withIdentity(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);

    const existing = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.role, 'super_admin'), isNull(organizationMembers.revokedAt)))
      .limit(1);
    if (existing.length > 0) return { created: false, reason: 'super_admin_exists' } as const;

    const taken = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (taken.length > 0) throw new BootstrapError('el email ya pertenece a un usuario existente; elige otro');

    let org = (await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.kind, 'platform')).limit(1))[0];
    if (!org) {
      [org] = await tx
        .insert(organizations)
        .values({ kind: 'platform', name: input.platformOrgName ?? 'Sales Smart Platform', timezone: 'UTC' })
        .returning({ id: organizations.id });
    }
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, status: 'active', emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    await tx.insert(organizationMembers).values({ userId: user!.id, organizationId: org!.id, role: 'super_admin', grantedBy: null });
    return { created: true, userId: user!.id, organizationId: org!.id, email, password } as const;
  });
}
