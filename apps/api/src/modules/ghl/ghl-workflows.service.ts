import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { contacts, Database, ghlContactLinks, ghlEnrollments, type TenantTx } from '../../db';
import { ConflictError, ServiceUnavailableError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { ContactsService, type ContactScope } from '../contacts';
import { OrgMembersService } from '../organizations';
import { GhlConnectionService } from './ghl-connection.service';
import { GHL_PROVIDER, GhlError, type GhlCredentials, type GhlProvider, type GhlWorkflow } from './ghl.ports';

/** Cuánto se reutiliza la lista de flujos de una empresa antes de volver a pedirla a GHL (el botón «Actualizar» la salta). */
export const GHL_WORKFLOWS_TTL_MS = 5 * 60_000;
/** Un mismo contacto no se inscribe dos veces en el mismo flujo dentro de este margen (doble clic, reintento del navegador). */
export const GHL_ENROLL_GUARD_MS = 60_000;
const HISTORY_LIMIT = 20;
const NOT_CONNECTED = 'GoHighLevel no está conectado o rechazó el token: el administrador debe revisar Configuración › GoHighLevel';

export interface GhlWorkflowView {
  id: string;
  name: string;
  /** Solo los publicados reciben contactos. */
  enrollable: boolean;
}

export interface GhlWorkflowList {
  items: GhlWorkflowView[];
  /** Cuándo se leyó de GHL (ISO): la lista puede venir de la memoria. */
  fetched_at: string;
}

export interface GhlEnrollmentView {
  id: string;
  workflow: { id: string; name: string };
  status: 'done' | 'failed';
  error: string | null;
  by: { id: string; name: string } | null;
  created_at: string;
}

type Labels = Map<string, { id: string; name: string }>;

/**
 * Inscripción de contactos en flujos (Workflows) de GoHighLevel (M7.5, ADR-52). La lista de flujos viene de GHL y se guarda en memoria 5 min por empresa; inscribir llama a GHL EN LA PETICIÓN
 * (fuera de toda transacción) para que quien lo pidió vea el resultado al instante, y deja un registro (`ghl_enrollments`) y su auditoría. El flujo debe existir y estar publicado en la lista
 * (nunca se manda un identificador arbitrario) y el contacto debe ser uno que la persona puede ver (404 uniforme). Un contacto que aún no está en GHL se busca o crea por teléfono o correo.
 */
@Injectable()
export class GhlWorkflowsService {
  private readonly cache = new Map<string, { at: number; items: GhlWorkflow[] }>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(GHL_PROVIDER) private readonly provider: GhlProvider,
    @Inject(GhlConnectionService) private readonly connection: GhlConnectionService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  /** Los flujos de la Location. `refresh` salta la memoria. */
  async list(refresh = false): Promise<GhlWorkflowList> {
    const creds = await this.db.withTenant(async (tx) => this.connection.credentials(tx));
    if (!creds) throw new ConflictError('GHL_NOT_CONNECTED', NOT_CONNECTED);
    const { items, at } = await this.workflows(refresh, creds);
    return { items: items.map((w) => ({ id: w.id, name: w.name, enrollable: w.status === 'published' })), fetched_at: new Date(at).toISOString() };
  }

  /** Vacía la memoria de flujos (las pruebas la usan entre casos). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Inscribe al contacto en el flujo. Devuelve el registro (también cuando GHL lo rechazó definitivamente: el motivo se ve y queda guardado). */
  async enroll(scope: ContactScope, contactId: string, workflowId: string): Promise<GhlEnrollmentView> {
    const userId = TenantContext.current().userId ?? null;
    // 1) Lo local, en una transacción corta: contacto visible, credenciales, vínculo con GHL e intentos recientes
    const prep = await this.db.withTenant(async (tx) => {
      const contact = await this.contacts.visibleContactIn(tx, scope, contactId);
      const creds = await this.connection.credentials(tx);
      if (!creds) throw new ConflictError('GHL_NOT_CONNECTED', NOT_CONNECTED);
      const [link] = await tx.select({ ghlContactId: ghlContactLinks.ghlContactId }).from(ghlContactLinks).where(eq(ghlContactLinks.contactId, contactId)).limit(1);
      const [row] = await tx.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
      const who = link ? null : await this.contacts.channelIdentity(tx, contactId);
      const recent = await tx
        .select({ workflowId: ghlEnrollments.workflowId, status: ghlEnrollments.status, createdAt: ghlEnrollments.createdAt })
        .from(ghlEnrollments)
        .where(eq(ghlEnrollments.contactId, contactId))
        .orderBy(desc(ghlEnrollments.createdAt))
        .limit(5);
      return { contact, creds: { locationId: creds.locationId, accessToken: creds.accessToken }, ghlContactId: link?.ghlContactId ?? null, email: row?.email ?? null, phone: who?.primaryPhone ?? null, recent };
    });
    // 2) El flujo debe existir y estar publicado (se valida con la lista, no con lo que mande el navegador)
    const wf = (await this.workflows(false, prep.creds)).items.find((w) => w.id === workflowId);
    if (!wf) throw new ValidationError([{ path: 'workflow_id', code: 'not_found', message: 'Ese flujo no existe en GoHighLevel (actualiza la lista)' }]);
    if (wf.status !== 'published') throw new ValidationError([{ path: 'workflow_id', code: 'not_published', message: 'Ese flujo no está publicado en GoHighLevel' }]);
    const now = Date.now();
    if (prep.recent.some((r) => r.workflowId === workflowId && r.status === 'done' && now - r.createdAt.getTime() < GHL_ENROLL_GUARD_MS)) {
      throw new ConflictError('GHL_ALREADY_ENROLLED', 'Este contacto ya se inscribió en ese flujo hace menos de un minuto');
    }
    // 3) La llamada a GHL, fuera de toda transacción
    let ghlContactId = prep.ghlContactId;
    let failure: GhlError | null = null;
    try {
      if (!ghlContactId) {
        if (!prep.phone && !prep.email) throw new GhlError('El contacto no tiene teléfono ni correo: no se puede buscar ni crear en GoHighLevel', false);
        const placeholder = prep.phone !== null && prep.contact.name === prep.phone;
        ghlContactId = (await this.provider.upsertContact(prep.creds, { name: placeholder ? null : prep.contact.name, phone: prep.phone, email: prep.email })).id;
      }
      await this.provider.enrollInWorkflow(prep.creds, ghlContactId, workflowId);
    } catch (e) {
      if (!(e instanceof GhlError)) throw e;
      failure = e;
    }
    if (failure?.credentials) await this.connection.rejectedByProvider(failure.message).catch(() => undefined);
    // Un fallo pasajero (red, límite de uso) no se registra: la persona vuelve a intentarlo y no queda un historial de intentos sin sentido
    if (failure?.retryable) throw new ServiceUnavailableError('GHL_UNAVAILABLE', `${failure.message}. Inténtalo de nuevo en un momento`);
    // 4) El registro y la auditoría, en una transacción propia
    const saved = await this.db.withTenant(async (tx) => {
      // Si el contacto era nuevo en GHL, queda vinculado (salvo que ese contacto de GHL ya sea de otro contacto de aquí)
      if (ghlContactId && !prep.ghlContactId) await this.linkIfFree(tx, contactId, ghlContactId);
      const [row] = await tx
        .insert(ghlEnrollments)
        .values({ contactId, workflowId, workflowName: wf.name, status: failure ? 'failed' : 'done', error: failure ? failure.message.slice(0, 300) : null, createdBy: userId, createdAt: new Date() })
        .returning();
      await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: 'ghl_workflow', newValue: { workflow_id: workflowId, workflow_name: wf.name, result: failure ? 'failed' : 'done' }, source: 'manual' });
      return row!;
    });
    const labels: Labels = userId ? await this.members.labels([userId]) : new Map();
    return this.view(saved, labels);
  }

  /** Últimas inscripciones del contacto (la más reciente primero). 404 uniforme si la persona no ve al contacto. */
  async history(scope: ContactScope, contactId: string): Promise<{ items: GhlEnrollmentView[] }> {
    const rows = await this.db.withTenant(async (tx) => {
      await this.contacts.visibleContactIn(tx, scope, contactId);
      return tx.select().from(ghlEnrollments).where(eq(ghlEnrollments.contactId, contactId)).orderBy(desc(ghlEnrollments.createdAt), desc(ghlEnrollments.id)).limit(HISTORY_LIMIT);
    });
    const labels = await this.members.labels([...new Set(rows.map((r) => r.createdBy).filter((x): x is string => x !== null))]);
    return { items: rows.map((r) => this.view(r, labels)) };
  }

  // ------------------------------------------------------------------ interno

  private view(r: typeof ghlEnrollments.$inferSelect, labels: Labels): GhlEnrollmentView {
    return { id: r.id, workflow: { id: r.workflowId, name: r.workflowName }, status: r.status as 'done' | 'failed', error: r.error, by: r.createdBy ? (labels.get(r.createdBy) ?? null) : null, created_at: r.createdAt.toISOString() };
  }

  private async linkIfFree(tx: TenantTx, contactId: string, ghlContactId: string): Promise<void> {
    const [other] = await tx.select({ contactId: ghlContactLinks.contactId }).from(ghlContactLinks).where(eq(ghlContactLinks.ghlContactId, ghlContactId)).limit(1);
    if (other) return;
    await tx.insert(ghlContactLinks).values({ ghlContactId, contactId }).onConflictDoNothing();
  }

  /** La lista de flujos: de la memoria si es reciente; si no, de GHL (con las credenciales de la empresa). Un token rechazado deja la conexión pidiendo reconexión. */
  private async workflows(refresh: boolean, creds: GhlCredentials): Promise<{ items: GhlWorkflow[]; at: number }> {
    // La memoria es por empresa Y por Location: al cambiar de subcuenta no se ven los flujos de la anterior
    const key = `${TenantContext.current().organizationId}|${creds.locationId}`;
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < GHL_WORKFLOWS_TTL_MS) return hit;
    try {
      const items = await this.provider.listWorkflows({ locationId: creds.locationId, accessToken: creds.accessToken });
      const fresh = { at: Date.now(), items };
      this.cache.set(key, fresh);
      return fresh;
    } catch (e) {
      if (!(e instanceof GhlError)) throw e;
      if (e.credentials) {
        await this.connection.rejectedByProvider(e.message).catch(() => undefined);
        throw new ConflictError('GHL_NOT_CONNECTED', 'GoHighLevel rechazó el token: el administrador debe reconectarlo en Configuración › GoHighLevel');
      }
      if (e.retryable) throw new ServiceUnavailableError('GHL_UNAVAILABLE', `${e.message}. Inténtalo de nuevo en un momento`);
      throw new ConflictError('GHL_REJECTED', e.message);
    }
  }
}
