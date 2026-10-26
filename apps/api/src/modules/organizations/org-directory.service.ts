import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, organizations, trialConfig } from '../../db';
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
  private readonly welcome = new Map<string, { at: number; value: number }>();

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

  /** Cambia la moneda de la empresa del contexto (la regla de cuándo se puede la aplica ventas). */
  async setCurrency(currency: string): Promise<void> {
    const org = TenantContext.current().organizationId;
    await this.db.withIdentity((tx) => tx.update(organizations).set({ currency, updatedAt: new Date() }).where(eq(organizations.id, org)));
  }

  /**
   * Créditos IA de bienvenida de la empresa del contexto (M8.1): los de `trial_config.welcome_credits` si es una empresa CLIENTE; 0 para agencias y la plataforma. Se lee ANTES de la transacción
   * de negocio (el monedero se crea la primera vez que se usa) y se guarda 60 s por empresa.
   */
  async welcomeCredits(now = Date.now()): Promise<number> {
    const org = TenantContext.current().organizationId;
    const hit = this.welcome.get(org);
    if (hit && now - hit.at < 60_000) return hit.value;
    const value = await this.db.withIdentity(async (tx) => {
      const [o] = await tx.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, org)).limit(1);
      if (o?.kind !== 'client') return 0;
      const [c] = await tx.select({ credits: trialConfig.welcomeCredits }).from(trialConfig).limit(1);
      return c?.credits ?? 0;
    });
    this.welcome.set(org, { at: now, value });
    return value;
  }

  /** ¿Existe esa organización y es una empresa CLIENTE? (la Súper Admin consulta o regala créditos a empresas ajenas al contexto). */
  async isClient(organizationId: string): Promise<boolean> {
    const [o] = await this.db.withIdentity((tx) => tx.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, organizationId)).limit(1));
    return o?.kind === 'client';
  }

  /** Las empresas CLIENTE (para las tareas que recorren a todas, como el procesamiento de documentos). */
  async clientOrganizationIds(): Promise<string[]> {
    const rows = await this.db.withIdentity((tx) => tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.kind, 'client')));
    return rows.map((r) => r.id);
  }

  invalidate(): void {
    this.welcome.clear();
    this.cache.clear();
  }
}
