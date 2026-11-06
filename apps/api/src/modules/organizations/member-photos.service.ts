import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Database, organizationMembers } from '../../db';
import { TenantContext } from '../../tenant';

/**
 * La foto de perfil de cada persona EN cada empresa (v5): `organization_members.photo_key`. Es identidad (ADR-25): los módulos de negocio no la leen directamente, la piden aquí. La empresa sale SIEMPRE de
 * `TenantContext`, nunca de un parámetro, y solo cuentan las membresías vigentes. Aquí solo hay CLAVES del almacenamiento; quien las entrega al cliente las firma.
 */
@Injectable()
export class MemberPhotosService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Las claves de foto de estas personas (solo las que tienen y siguen en la empresa). */
  async keysFor(userIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const org = TenantContext.current().organizationId;
    const rows = await this.db.withIdentity((tx) =>
      tx.select({ userId: organizationMembers.userId, key: organizationMembers.photoKey }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, org), isNull(organizationMembers.revokedAt), inArray(organizationMembers.userId, unique))),
    );
    return new Map(rows.flatMap((r) => (r.key ? [[r.userId, r.key] as [string, string]] : [])));
  }

  /** Cambia la foto de esta persona en la empresa del contexto. Devuelve la clave anterior (null si no tenía) o `undefined` si no es miembro vigente. */
  async replace(userId: string, key: string | null): Promise<{ previous: string | null } | undefined> {
    const org = TenantContext.current().organizationId;
    return this.db.withIdentity(async (tx) => {
      const [cur] = await tx
        .select({ id: organizationMembers.id, key: organizationMembers.photoKey })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, org), eq(organizationMembers.userId, userId), isNull(organizationMembers.revokedAt)))
        .for('update')
        .limit(1);
      if (!cur) return undefined;
      await tx.update(organizationMembers).set({ photoKey: key }).where(eq(organizationMembers.id, cur.id));
      return { previous: cur.key };
    });
  }
}
