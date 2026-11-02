import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { agents, channelAccounts, Database, formSubmissions, forms, queueMembers } from '../../db';
import { TenantContext } from '../../tenant';
import { InvitationsService } from '../auth';
import { TeamMembersService } from '../organizations';
import { SAMPLE_KEYS } from './sample-data.service';

export interface OnboardingStep {
  id: 'channel' | 'advisor' | 'department' | 'agent' | 'form';
  label: string;
  hint: string;
  done: boolean;
  /** Pantalla donde se hace. */
  to: string;
}
export interface OnboardingView {
  steps: OnboardingStep[];
  done: number;
  total: number;
  complete: boolean;
}

/**
 * «Primeros pasos» del administrador (M10.6, ADR-56 B5 #5): cinco pasos DERIVADOS de datos que ya existen (sin tabla nueva), así que se marcan solos al hacerlos y no pueden quedar
 * desfasados. La tarjeta se oculta sola al completarse y se puede cerrar (esa preferencia vive en el navegador).
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TeamMembersService) private readonly team: TeamMembersService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
  ) {}

  async view(): Promise<OnboardingView> {
    const me = TenantContext.current().userId ?? null;
    const [members, pending, biz] = await Promise.all([
      this.team.list(),
      this.invitations.listMemberInvitations(),
      this.db.withTenant(async (tx) => {
        // Una conexión real: la de GoHighLevel se crea sola con su integración y no cuenta como un canal de clientes
        const channels = await tx.select({ id: channelAccounts.id }).from(channelAccounts).where(and(isNull(channelAccounts.deletedAt), ne(channelAccounts.provider, 'ghl'))).limit(1);
        // Alguien más que el administrador participando en un departamento
        const assigned = await tx.select({ u: queueMembers.userId }).from(queueMembers).where(and(eq(queueMembers.active, true), me ? ne(queueMembers.userId, me) : sql`true`)).limit(1);
        // El agente de ejemplo se «revisó» si ya no está intacto (se editó), se borró o hay agentes propios
        const ags = await tx.select({ id: agents.id, sample: agents.sampleKey, created: agents.createdAt, updated: agents.updatedAt, active: agents.active }).from(agents).where(isNull(agents.deletedAt));
        const sample = ags.find((a) => a.sample === SAMPLE_KEYS.agent);
        const reviewed = !sample || ags.some((a) => a.sample === null) || sample.active || sample.updated.getTime() - sample.created.getTime() > 5_000;
        // Un formulario publicado o con envíos (se probó)
        const published = await tx.select({ id: forms.id }).from(forms).where(and(isNull(forms.deletedAt), ne(forms.status, 'draft'))).limit(1);
        const submitted = await tx.select({ id: formSubmissions.id }).from(formSubmissions).limit(1);
        return { channel: channels.length > 0, assigned: assigned.length > 0, reviewed, form: published.length > 0 || submitted.length > 0 };
      }),
    ]);
    const advisor = members.some((m) => m.role === 'advisor') || pending.some((i) => i.role === 'advisor');
    const steps: OnboardingStep[] = [
      { id: 'channel', label: 'Conecta un canal', hint: 'WhatsApp oficial o por QR: por ahí te escriben tus clientes.', done: biz.channel, to: '/settings/connections' },
      { id: 'advisor', label: 'Invita a un asesor', hint: 'Dale acceso a tu equipo con los permisos que necesite.', done: advisor, to: '/users' },
      { id: 'department', label: 'Asígnalo a un departamento', hint: 'Así le llegan las conversaciones nuevas.', done: biz.assigned, to: '/departments' },
      { id: 'agent', label: 'Revisa el agente de ejemplo', hint: 'Está apagado: míralo, cámbialo o bórralo.', done: biz.reviewed, to: '/agents' },
      { id: 'form', label: 'Publica o prueba el formulario', hint: 'El de ejemplo está en borrador.', done: biz.form, to: '/forms' },
    ];
    const done = steps.filter((s) => s.done).length;
    return { steps, done, total: steps.length, complete: done === steps.length };
  }
}
