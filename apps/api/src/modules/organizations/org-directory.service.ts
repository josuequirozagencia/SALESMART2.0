import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, organizations } from '../../db';
import { TenantContext } from '../../tenant';
import { OrgMembersService } from './org-members.service';

export interface OrgDirectory {
  readonly timeZone: string;
  /** Personas que pueden recibir trabajo hoy. */
  readonly assignable: ReadonlySet<string>;
}

const CACHE_MS = 30_000;
const FALLBACK_ZONE = 'UTC';

/**
 * Lo que el reparto de conversaciones necesita de la IDENTIDAD de la empresa del contexto: su zona horaria y quiénes pueden recibir trabajo (M5.3). Se lee ANTES de
 * abrir la transacción de negocio (las tablas de identidad no se pueden tocar dentro de ella) y se guarda 30 s por empresa: la tarea que procesa los avisos lo pide
 * en cada pasada. Quien revocó su membresía puede recibir una conversación hasta 30 s después, como máximo.
 */
@Injectable()
export class OrgDirectoryService {
  private readonly cache = new Map<string, { at: number; value: OrgDirectory }>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  /** La organización sale SIEMPRE del TenantContext. `fresh` ignora lo guardado (acciones de una persona, no de la tarea periódica). */
  async current(opts: { fresh?: boolean; now?: number } = {}): Promise<OrgDirectory> {
    const org = TenantContext.current().organizationId;
    const now = opts.now ?? Date.now();
    const hit = this.cache.get(org);
    if (!opts.fresh && hit && now - hit.at < CACHE_MS) return hit.value;
    const [row] = await this.db.withIdentity((tx) => tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, org)).limit(1));
    const people = await this.members.assignable();
    const value: OrgDirectory = { timeZone: row?.timezone || FALLBACK_ZONE, assignable: new Set(people.map((p) => p.id)) };
    this.cache.set(org, { at: now, value });
    return value;
  }

  /** El nombre de la empresa del contexto, para las variables de las respuestas rápidas (`{{empresa}}`). Se lee ANTES de la transacción de negocio. */
  async organizationName(): Promise<string> {
    const org = TenantContext.current().organizationId;
    const [row] = await this.db.withIdentity((tx) => tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org)).limit(1));
    return row?.name ?? '';
  }

  /** Moneda de la empresa del contexto (ISO 4217). Se lee ANTES de la transacción de negocio. */
  async currency(): Promise<string> {
    const org = TenantContext.current().organizationId;
    const [row] = await this.db.withIdentity((tx) => tx.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, org)).limit(1));
    return row?.currency ?? 'USD';
  }

  invalidate(): void {
    this.cache.clear();
  }
}
