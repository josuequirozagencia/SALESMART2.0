import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { automationSettings, Database } from '../../db';
import { ValidationError, type ErrorDetail } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { MAX_ALLOWED_HOSTS, normalizeAllowedHost } from './address-guard';

export interface AutomationSettingsView {
  /** Dominios a los que las automatizaciones pueden llamar (exactos o `*.dominio`). */
  http_allowed_hosts: string[];
  limits: { max_hosts: number };
}

/**
 * Ajustes de las automatizaciones de la empresa (M9.5b, ADR-54): hoy, la **lista de permitidos** de la acción «llamada HTTP». Solo quien administra automatizaciones (`automations.manage`).
 * Cada dominio se valida en el servidor (nombre de dominio público; nunca una IP, `localhost` ni una dirección con puerto) y cada cambio queda auditado.
 */
@Injectable()
export class AutomationSettingsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async get(): Promise<AutomationSettingsView> {
    const [row] = await this.db.withTenant((tx) => tx.select().from(automationSettings).limit(1));
    return this.view(row?.httpAllowedHosts ?? []);
  }

  async update(input: { http_allowed_hosts: string[] }): Promise<AutomationSettingsView> {
    const issues: ErrorDetail[] = [];
    const clean: string[] = [];
    for (const [i, raw] of input.http_allowed_hosts.entries()) {
      const h = normalizeAllowedHost(raw);
      if (!h) issues.push({ path: `http_allowed_hosts.${i}`, code: 'invalid', message: `«${raw.trim().slice(0, 80)}» no es un dominio válido: escribe un nombre como «mi-sistema.com» o «*.mi-sistema.com» (sin https://, sin puerto y nunca una dirección IP)` });
      else if (!clean.includes(h)) clean.push(h);
    }
    if (clean.length > MAX_ALLOWED_HOSTS) issues.push({ path: 'http_allowed_hosts', code: 'too_many', message: `Máximo ${MAX_ALLOWED_HOSTS} dominios` });
    if (issues.length > 0) throw new ValidationError(issues);
    const userId = TenantContext.current().userId ?? null;
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(automationSettings).limit(1).for('update');
      const before = cur?.httpAllowedHosts ?? [];
      if (before.length === clean.length && before.every((h, i) => h === clean[i])) return;
      let id = cur?.id;
      if (cur) await tx.update(automationSettings).set({ httpAllowedHosts: clean, updatedBy: userId, updatedAt: new Date() }).where(eq(automationSettings.id, cur.id));
      else id = (await tx.insert(automationSettings).values({ httpAllowedHosts: clean, updatedBy: userId }).returning({ id: automationSettings.id }))[0]!.id;
      await writeAudit(tx, { entityType: 'automation_settings', entityId: id!, field: 'http_allowed_hosts', oldValue: before, newValue: clean, source: 'manual' });
    });
    return this.view(clean);
  }

  private view(hosts: readonly string[]): AutomationSettingsView {
    return { http_allowed_hosts: [...hosts], limits: { max_hosts: MAX_ALLOWED_HOSTS } };
  }
}
