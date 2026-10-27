import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { Database, formRoutes } from '../../db';
import { TenantContext } from '../../tenant';

/**
 * Punto de entrada PÚBLICO de cada formulario (M9.1, ADR-09/54). Tabla de IDENTIDAD: quien llena el formulario en una landing llega sin sesión y hay que saber de qué empresa y formulario es antes de
 * que exista contexto. El «token» de la URL es un UUID v4 aleatorio (no secuencial ni derivado de la empresa) y SOLO permite enviar: no hay nada que leer con él salvo la definición pública del formulario.
 * La empresa de `issue`/`tokenFor` sale siempre de `TenantContext`; `resolve` recibe lo que trae la URL y devuelve null si no existe.
 */
@Injectable()
export class FormRoutesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** El token del formulario; lo crea si aún no tiene (un formulario, un token; no se rota). */
  async issue(formId: string): Promise<string> {
    const org = TenantContext.current().organizationId;
    return this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select({ id: formRoutes.id }).from(formRoutes).where(eq(formRoutes.formId, formId)).limit(1);
      if (cur) return cur.id;
      const id = randomUUID();
      await tx.insert(formRoutes).values({ id, organizationId: org, formId });
      return id;
    });
  }

  /** Tokens de varios formularios de la empresa del contexto (para las listas). */
  async tokensFor(formIds: readonly string[]): Promise<Map<string, string>> {
    if (formIds.length === 0) return new Map();
    const org = TenantContext.current().organizationId;
    const rows = await this.db.withIdentity((tx) => tx.select({ id: formRoutes.id, formId: formRoutes.formId, organizationId: formRoutes.organizationId }).from(formRoutes).where(inArray(formRoutes.formId, [...formIds])));
    return new Map(rows.filter((r) => r.organizationId === org).map((r) => [r.formId, r.id]));
  }

  /** Empresa y formulario de un token público, o null (inexistente). No distingue más: quien llama responde 404 uniforme. */
  async resolve(token: string): Promise<{ organizationId: string; formId: string } | null> {
    const [row] = await this.db.withIdentity((tx) => tx.select({ organizationId: formRoutes.organizationId, formId: formRoutes.formId }).from(formRoutes).where(eq(formRoutes.id, token)).limit(1));
    return row ?? null;
  }
}
