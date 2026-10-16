import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Database, organizationMembers, users } from '../../db';
import { TenantContext } from '../../tenant';

export interface OrgPerson {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Personas de la organización del CONTEXTO para los módulos de negocio (contactos: dueño de un contacto). Las membresías y los usuarios son tablas de
 * IDENTIDAD (ADR-25): los módulos de negocio no las leen directamente (`app_rw` no tiene acceso); piden estos datos aquí. La organización sale
 * SIEMPRE de `TenantContext`, nunca de un parámetro. Solo lectura.
 */
@Injectable()
export class OrgMembersService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Personas a las que se puede ASIGNAR trabajo (administradores y asesores vigentes con usuario activo), por nombre. */
  async assignable(): Promise<OrgPerson[]> {
    const org = TenantContext.current().organizationId;
    const rows = await this.db.withIdentity((tx) =>
      tx
        .select({ id: users.id, fullName: users.fullName, email: users.email, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, org), isNull(organizationMembers.revokedAt), inArray(organizationMembers.role, ['client_admin', 'advisor']), eq(users.status, 'active'), isNull(users.deletedAt)))
        .orderBy(asc(users.fullName), asc(users.email)),
    );
    return rows.map((r) => ({ id: r.id, name: r.fullName ?? r.email, email: r.email, role: r.role }));
  }

  /** ¿Puede esta persona recibir trabajo en la organización del contexto? */
  async canBeAssigned(userId: string): Promise<boolean> {
    return (await this.assignable()).some((p) => p.id === userId);
  }

  /** Nombre y correo para MOSTRAR (aunque la persona ya no sea miembro: un contacto puede seguir llevando su nombre). Solo de los ids pedidos. */
  async labels(ids: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.withIdentity((tx) => tx.select({ id: users.id, fullName: users.fullName, email: users.email }).from(users).where(inArray(users.id, unique)));
    return new Map(rows.map((r) => [r.id, { id: r.id, name: r.fullName ?? r.email }]));
  }
}
