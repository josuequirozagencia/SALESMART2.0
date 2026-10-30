import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AppError, ConflictError, ValidationError } from '../../errors';
import { MANAGEABLE_KEYS, PERMISSION_GROUPS, PERMISSION_META, ROLE_PERMISSIONS, effectivePermissions, isGrantable, type PermissionKey } from '../../rbac';
import { TenantContext } from '../../tenant';
import { AuditService } from '../audit';
import { InvitationsService, memberJoined, type InvitationIssued, type MemberInvitationView } from '../auth';
import { OwnerReleaseService } from '../inbox';
import { OrgDirectoryService, OrgMembersService, TeamMembersService, type TeamMember, type TeamMemberDetail, type TeamRole } from '../organizations';
import { QueuesService } from '../queues';
import type { DepartmentsDto, InviteDto, LeaveDto, PermissionsDto } from './team.dto';

export interface DepartmentRef {
  id: string;
  name: string;
  color: string;
}
export type TeamMemberView = TeamMember & { departments: DepartmentRef[] };
export interface TeamList {
  items: TeamMemberView[];
  invitations: MemberInvitationView[];
}
export interface TeamMemberFull extends TeamMemberView {
  overrides: TeamMemberDetail['overrides'];
  /** Lo que da la plantilla del rol, sin ajustes. */
  template: PermissionKey[];
  /** Lo que realmente puede hacer hoy (plantilla + ajustes). */
  effective: PermissionKey[];
  /** Conversaciones abiertas que tiene asignadas (para el diálogo de desactivar o quitar). */
  open_conversations: number;
}
export interface LeaveResult {
  user_id: string;
  status: 'deactivated' | 'removed';
  conversations: { action: 'transfer' | 'unassign'; moved: number; to_user_id: string | null };
  collaborations_removed: number;
  sessions_revoked: number;
}

const ROLE_LABEL: Record<TeamRole, string> = { client_admin: 'Administrador', advisor: 'Asesor' };

/**
 * Usuarios del equipo (M10.3, ADR-56 B3): coordina lo de identidad (membresías, ajustes de permisos, invitaciones) con lo de negocio (conversaciones, departamentos) SIN tocar
 * las tablas de identidad (las toca `TeamMembersService`, en `organizations`). Todo es de la empresa del contexto; el permiso `users.manage` lo exige el controlador.
 *  - Los ajustes de permisos están acotados por el techo del rol y por lo que tiene quien los otorga.
 *  - Desactivar o quitar a alguien exige ELEGIR qué pasa con sus conversaciones abiertas (pasarlas a otra persona o dejarlas sin asignación) y comprueba antes de tocar nada
 *    que se pueda (no a uno mismo, no al último administrador). Orden: comprobar → liberar sus conversaciones (por lotes, idempotente) → sacarlo (identidad, con las filas
 *    bloqueadas y las sesiones cerradas) → sacarlo de los departamentos. Si algo falla a medias, repetir la operación termina el trabajo sin duplicar nada.
 */
@Injectable()
export class TeamService implements OnModuleInit {
  constructor(
    @Inject(TeamMembersService) private readonly members: TeamMembersService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(OwnerReleaseService) private readonly release: OwnerReleaseService,
    @Inject(OrgMembersService) private readonly people: OrgMembersService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Los departamentos elegidos al invitar se aplican cuando la persona acepta (la aceptación es pública y de identidad). */
  onModuleInit(): void {
    memberJoined.register(async (e) => {
      await TenantContext.run({ organizationId: e.organizationId }, async () => {
        await this.queues.setUserDepartments(e.userId, e.setup.queue_ids);
        this.directory.invalidate();
      });
    });
  }

  /** El catálogo de permisos agrupado, con lo que cada rol trae y lo que se puede conceder (para la pantalla de usuarios). */
  catalog(holder: ReadonlySet<PermissionKey>) {
    const admin = new Set<PermissionKey>(ROLE_PERMISSIONS.client_admin);
    const advisor = new Set<PermissionKey>(ROLE_PERMISSIONS.advisor);
    return {
      roles: [
        { id: 'client_admin' as const, label: ROLE_LABEL.client_admin, description: 'Administra toda la empresa y ve a todos.' },
        { id: 'advisor' as const, label: ROLE_LABEL.advisor, description: 'Atiende a sus clientes: ve solo lo suyo y lo que le comparten.' },
      ],
      groups: PERMISSION_GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        items: MANAGEABLE_KEYS.filter((k) => PERMISSION_META[k].group === g.id).map((k) => ({
          key: k,
          label: PERMISSION_META[k].label,
          hint: PERMISSION_META[k].hint,
          reach: PERMISSION_META[k].reach,
          in_role: { client_admin: admin.has(k), advisor: advisor.has(k) },
          grantable_to_advisor: isGrantable('advisor', k),
          /** ¿Puede quien consulta concederlo? (nadie concede lo que no tiene). */
          holder_can_grant: isGrantable('advisor', k) && holder.has(k),
        })),
      })).filter((g) => g.items.length > 0),
    };
  }

  async list(): Promise<TeamList> {
    const [items, invitations] = await Promise.all([this.members.list(), this.invitations.listMemberInvitations()]);
    const depts = await this.queues.departmentsOf(items.filter((m) => m.status === 'active').map((m) => m.user_id));
    return { items: items.map((m) => ({ ...m, departments: depts.get(m.user_id) ?? [] })), invitations };
  }

  async get(userId: string): Promise<TeamMemberFull> {
    const d = await this.members.get(userId);
    const [depts, open] = await Promise.all([this.queues.departmentsOf([userId]), this.release.openCount(userId)]);
    const template = new Set<PermissionKey>(ROLE_PERMISSIONS[d.role]);
    const effective = effectivePermissions(d.role, template, d.overrides);
    const { overrides, ...member } = d;
    return { ...member, departments: depts.get(userId) ?? [], overrides, template: [...template], effective: [...effective], open_conversations: open };
  }

  async invite(dto: InviteDto, holder: ReadonlySet<PermissionKey>): Promise<InvitationIssued & { id: string }> {
    const grant = (dto.permissions?.grant ?? []) as PermissionKey[];
    const deny = (dto.permissions?.deny ?? []) as PermissionKey[];
    const queueIds = dto.queue_ids ?? [];
    if (!(await this.queues.allExist(queueIds))) throw new ValidationError([{ path: 'queue_ids', code: 'not_found', message: 'Alguno de los departamentos no existe o está archivado' }]);
    return this.invitations.inviteMember({ email: dto.email, role: dto.role, setup: { grant, deny, queue_ids: queueIds } }, holder);
  }

  resendInvitation(id: string): Promise<InvitationIssued & { id: string }> {
    return this.invitations.resendMemberInvitation(id);
  }

  cancelInvitation(id: string): Promise<{ id: string; cancelled: true }> {
    return this.invitations.cancelMemberInvitation(id);
  }

  async changeRole(userId: string, role: TeamRole): Promise<TeamMemberFull> {
    const r = await this.members.changeRole(userId, role);
    await this.audit.record({ entityType: 'user', entityId: userId, field: 'role', oldValue: r.before, newValue: r.after, source: 'manual' });
    this.directory.invalidate();
    return this.get(userId);
  }

  async setPermissions(userId: string, dto: PermissionsDto, holder: ReadonlySet<PermissionKey>): Promise<TeamMemberFull> {
    // Una clave que no existe no se descarta en silencio: la validación la rechaza con su motivo
    const r = await this.members.setOverrides(userId, { grant: dto.grant as PermissionKey[], deny: dto.deny as PermissionKey[] }, holder);
    await this.audit.record({ entityType: 'user', entityId: userId, field: 'permissions', oldValue: r.before, newValue: r.after, source: 'manual' });
    return this.get(userId);
  }

  async setDepartments(userId: string, dto: DepartmentsDto): Promise<TeamMemberFull> {
    const m = await this.members.get(userId);
    if (m.status !== 'active') throw new ConflictError('MEMBER_INACTIVE', 'Esa persona está desactivada: reactívala antes de cambiar sus departamentos');
    const r = await this.queues.setUserDepartments(userId, dto.queue_ids);
    await this.members.log('queues_changed', userId, r.before, r.after);
    this.directory.invalidate();
    return this.get(userId);
  }

  /** Desactiva (se puede reactivar) o quita (definitivo) a una persona, resolviendo antes lo que pasa con sus conversaciones abiertas. */
  async leave(userId: string, reason: 'deactivated' | 'removed', dto: LeaveDto): Promise<LeaveResult> {
    const plan = dto.conversations;
    const actorId = TenantContext.current().userId!;
    // 1) Comprobaciones previas (nada cambia todavía): la persona existe, no es uno mismo ni el último administrador
    const leaver = await this.members.checkCanLeave(userId, reason);
    // 2) El destino de las conversaciones debe poder recibir trabajo y no ser quien sale
    let target: { id: string; name: string } | null = null;
    if (plan.action === 'transfer') {
      const to = plan.to_user_id!;
      const person = (await this.people.assignable()).find((p) => p.id === to);
      if (to === userId || !person) throw new AppError(400, 'TRANSFER_TARGET_NOT_ALLOWED', 'Esa persona no puede recibir conversaciones en esta empresa');
      target = { id: person.id, name: person.name };
    }
    // 3) Liberar su trabajo (por lotes; repetir no duplica nada) y sacarla de los departamentos
    const labels = await this.people.labels([actorId]);
    const actorName = labels.get(actorId)?.name ?? 'Un administrador';
    const released = await this.release.release(userId, target ? { action: 'transfer', to: target.id, toName: target.name } : { action: 'unassign' }, { id: actorId, name: actorName }, leaver.name);
    // 4) Sacarla del equipo (identidad: membresía, sesiones, historia)
    const left = await this.members.leave(userId, reason);
    // 5) Sacarla de los departamentos (si es una persona ya desactivada que se quita, ya no está en ninguno)
    await this.queues.setUserDepartments(userId, []);
    this.directory.invalidate();
    await this.audit.record({
      entityType: 'user',
      entityId: userId,
      field: reason,
      newValue: { role: left.role, conversations: { action: plan.action, moved: released.moved, to_user_id: target?.id ?? null }, collaborations_removed: released.collaborations, sessions_revoked: left.sessionsRevoked },
      source: 'manual',
    });
    return { user_id: userId, status: reason, conversations: { action: plan.action, moved: released.moved, to_user_id: target?.id ?? null }, collaborations_removed: released.collaborations, sessions_revoked: left.sessionsRevoked };
  }

  async reactivate(userId: string): Promise<TeamMemberFull> {
    const r = await this.members.reactivate(userId);
    await this.audit.record({ entityType: 'user', entityId: userId, field: 'reactivated', newValue: { role: r.role }, source: 'manual' });
    this.directory.invalidate();
    return this.get(userId);
  }

  async revokeSessions(userId: string): Promise<{ user_id: string; sessions_revoked: number }> {
    const r = await this.members.revokeSessions(userId);
    await this.audit.record({ entityType: 'user', entityId: userId, field: 'sessions_revoked', newValue: { revoked: r.revoked }, source: 'manual' });
    return { user_id: userId, sessions_revoked: r.revoked };
  }

  history(limit?: number) {
    return this.members.history(limit);
  }
}
