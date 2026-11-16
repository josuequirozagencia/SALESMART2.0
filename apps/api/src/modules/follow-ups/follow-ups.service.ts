import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import { agentChannels, agentFollowUpFiles, agentFollowUpRuns, agentFollowUps, agentFollowUpSteps, automations, channelAccounts, Database } from '../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AgentsService } from '../ai';
import { writeAudit } from '../audit';
import { AttachmentsService, baseMime, MAX_BYTES, outboundKind } from '../attachments';
import { variablesIn } from '../quick-replies';
import { cumulativeMinutes, disallowedVariables, FILES_GHL_MESSAGE, FILES_OUTSIDE_WINDOW_MESSAGE, FOLLOW_UP_VARIABLES, insideOfficialWindow, MAX_FILES_PER_STEP, SCENARIO } from './follow-up-rules';
import type { FollowUpFileView, FollowUpsView, SetFollowUpsDto } from './follow-ups.dto';

type Tx = Parameters<Parameters<Database['withTenant']>[0]>[0];

/** Archivos de seguimiento que una secuencia puede tener a la vez (5 pasos × 3 archivos). */
const MAX_FILES_PER_AGENT = 15;

const KIND_LABEL: Record<string, string> = { image: 'La imagen', video: 'El video', audio: 'El audio', document: 'El documento' };

/**
 * La configuración de los seguimientos de un agente (v11 S5, ADR-68): GET y PUT de la secuencia completa del escenario «El contacto dejó de responder». Solo el administrador (`agents.manage`).
 * El servidor valida todo (la pantalla es ayuda): pasos de 1 a 5 en orden, textos con solo las variables permitidas y automatizaciones que existan, estén activas y sean de la empresa.
 * Guardar apagado o con cero pasos es válido; lo que ya estaba programado se cancela solo (el motor lo comprueba antes de cada envío: «el escenario se deshabilitó» o «el paso ya no existe»).
 *
 * v15: los pasos de texto fijo pueden llevar hasta 3 archivos. Se suben aparte (`uploadFile`, con las mismas reglas de tipo REAL, tamaño y antivirus que los adjuntos de conversación), se asignan a un paso
 * al guardar la secuencia (`file_ids`) y se validan contra los canales del agente: GoHighLevel no admite archivos y, por WhatsApp oficial, un paso que cae pasadas 24 h de espera acumulada solo podría
 * enviar una plantilla. Un archivo quitado o sin asignar vence y la tarea borra el objeto del almacenamiento.
 */
@Injectable()
export class FollowUpsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
  ) {}

  async get(agentId: string): Promise<FollowUpsView> {
    await this.agents.runtimeSettings(agentId); // 404 uniforme si no existe o es de otra empresa
    const storageOk = await this.files.available();
    return this.db.withTenant((tx) => this.view(tx, agentId, storageOk));
  }

  async set(agentId: string, input: SetFollowUpsDto): Promise<FollowUpsView> {
    await this.agents.runtimeSettings(agentId);
    this.validateTexts(input);
    const userId = TenantContext.current().userId ?? null;
    const storageOk = await this.files.available();
    return this.db.withTenant(async (tx) => {
      const ids = [...new Set(input.steps.map((s) => s.start_automation_id).filter((x): x is string => !!x))];
      if (ids.length > 0) {
        const ok = await tx.select({ id: automations.id }).from(automations).where(and(inArray(automations.id, ids), isNull(automations.deletedAt)));
        if (ok.length !== ids.length) throw new ValidationError([{ path: 'steps', code: 'automation_not_found', message: 'Alguna de las automatizaciones elegidas no existe' }]);
      }
      const before = await this.view(tx, agentId, storageOk);
      const [row] = await tx
        .insert(agentFollowUps)
        .values({ agentId, scenario: SCENARIO, enabled: input.enabled, updatedBy: userId })
        .onConflictDoUpdate({ target: [agentFollowUps.organizationId, agentFollowUps.agentId, agentFollowUps.scenario], set: { enabled: input.enabled, updatedBy: userId, updatedAt: new Date() } })
        .returning({ id: agentFollowUps.id });
      const followUpId = row!.id;
      const assignments = await this.validateFiles(tx, agentId, followUpId, input);
      await tx.delete(agentFollowUpSteps).where(eq(agentFollowUpSteps.followUpId, followUpId));
      if (input.steps.length > 0) {
        await tx.insert(agentFollowUpSteps).values(
          input.steps.map((s, i) => ({ followUpId, position: i + 1, delayMinutes: s.delay_minutes, mode: s.mode, fixedText: s.mode === 'fixed_text' ? (s.fixed_text ?? null) : null, startAutomationId: s.start_automation_id ?? null })),
        );
      }
      await this.applyAssignments(tx, followUpId, assignments);
      const after = await this.view(tx, agentId, storageOk);
      const shape = (v: FollowUpsView) => ({ enabled: v.enabled, steps: v.steps.map((s) => ({ delay_minutes: s.delay_minutes, mode: s.mode, has_text: s.fixed_text !== null, automation: s.start_automation_id, files: s.files.map((f) => `${f.kind}:${f.size_bytes}`) })) });
      if (JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) await writeAudit(tx, { entityType: 'agent', entityId: agentId, field: 'follow_ups', oldValue: shape(before), newValue: shape(after), source: 'manual' }); // el texto y el contenido no van a la auditoría
      return after;
    });
  }

  // ------------------------------------------------------------------ archivos de los pasos (v15)

  /**
   * Sube un archivo para un paso. Mismas reglas que un adjunto de conversación (tipo declarado, tamaño, contenido REAL, antivirus; un audio grabado por el navegador se convierte a OGG/Opus) más las del
   * canal: GoHighLevel no admite archivos. Queda «sin asignar» hasta guardar la secuencia con su `file_ids` (si no, vence a las 24 h). 413/415/422/503 como en la conversación.
   */
  async uploadFile(agentId: string, file: { bytes: Buffer; contentType: string | undefined; filename: string | null }): Promise<FollowUpFileView> {
    await this.agents.runtimeSettings(agentId);
    const userId = TenantContext.current().userId ?? null;
    const organizationId = TenantContext.current().organizationId;
    // El tamaño se dice con el número real y el máximo del tipo, antes de revisar nada más
    const declared = outboundKind(baseMime(file.contentType));
    if (declared && file.bytes.length > MAX_BYTES[declared]) {
      const mb = (n: number): string => (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1).replace('.0', '');
      throw new AppError(413, 'ATTACHMENT_TOO_LARGE', `${KIND_LABEL[declared] ?? 'El archivo'} pesa ${mb(file.bytes.length)} MB; WhatsApp permite hasta ${Math.floor(MAX_BYTES[declared] / (1024 * 1024))} MB`);
    }
    // Primero lo barato: que el agente exista, no atienda GoHighLevel y no esté lleno (no se gasta almacenamiento ni antivirus en algo que no se podría usar)
    const followUpId = await this.db.withTenant(async (tx) => {
      const channels = await this.channelsOf(tx, agentId);
      if (channels.ghl) throw new ConflictError('FOLLOW_UP_FILES_GHL', FILES_GHL_MESSAGE);
      const [fu] = await tx
        .insert(agentFollowUps)
        .values({ agentId, scenario: SCENARIO, enabled: false, updatedBy: userId })
        .onConflictDoUpdate({ target: [agentFollowUps.organizationId, agentFollowUps.agentId, agentFollowUps.scenario], set: { updatedAt: sql`${agentFollowUps.updatedAt}` } })
        .returning({ id: agentFollowUps.id });
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentFollowUpFiles).where(and(eq(agentFollowUpFiles.followUpId, fu!.id), eq(agentFollowUpFiles.state, 'ready')));
      if ((n?.n ?? 0) >= MAX_FILES_PER_AGENT) throw new ConflictError('FOLLOW_UP_FILES_LIMIT', `Un agente puede tener hasta ${MAX_FILES_PER_AGENT} archivos en sus seguimientos: quita alguno`);
      return fu!.id;
    });
    const prepared = await this.files.prepareUpload(file.bytes, file.contentType, file.filename);
    if (prepared.kind === 'sticker') throw new AppError(415, 'ATTACHMENT_UNSUPPORTED_TYPE', 'Un seguimiento puede llevar imágenes, documentos, videos o audios');
    const id = uuidv7();
    const stored = await this.files.scanAndStore(organizationId, id, prepared, `follow-ups/${followUpId}`);
    try {
      const view = await this.db.withTenant(async (tx) => {
        const [row] = await tx
          .insert(agentFollowUpFiles)
          .values({ id, followUpId, kind: prepared.kind, mimeType: prepared.mime, filename: prepared.filename, sizeBytes: prepared.bytes.length, storageKey: stored.key, checksum: prepared.checksum, scanStatus: stored.scanStatus, createdBy: userId })
          .returning();
        await writeAudit(tx, { entityType: 'agent', entityId: agentId, field: 'follow_up_file_added', oldValue: null, newValue: { kind: prepared.kind, size_bytes: prepared.bytes.length, name: prepared.filename }, source: 'manual' });
        return fileView(row!);
      });
      return view;
    } catch (e) {
      await this.files.remove(stored.key); // si no se pudo anotar, no queda suelto en el almacenamiento
      throw e;
    }
  }

  /** Quita un archivo: queda vencido (la tarea borra el objeto del almacenamiento) y sale de su paso. 404 si no es de este agente. Lo ya enviado a clientes no se toca (cada envío tiene su propia copia). */
  async removeFile(agentId: string, fileId: string): Promise<FollowUpsView> {
    await this.agents.runtimeSettings(agentId);
    const storageOk = await this.files.available();
    return this.db.withTenant(async (tx) => {
      const [f] = await tx
        .select({ id: agentFollowUpFiles.id, kind: agentFollowUpFiles.kind, size: agentFollowUpFiles.sizeBytes, name: agentFollowUpFiles.filename })
        .from(agentFollowUpFiles)
        .innerJoin(agentFollowUps, and(eq(agentFollowUps.id, agentFollowUpFiles.followUpId), eq(agentFollowUps.organizationId, agentFollowUpFiles.organizationId)))
        .where(and(eq(agentFollowUpFiles.id, fileId), eq(agentFollowUps.agentId, agentId), eq(agentFollowUpFiles.state, 'ready')))
        .limit(1);
      if (!f) throw new NotFoundError();
      await tx.update(agentFollowUpFiles).set({ state: 'expired', stepPosition: null, updatedAt: new Date() }).where(eq(agentFollowUpFiles.id, fileId));
      await writeAudit(tx, { entityType: 'agent', entityId: agentId, field: 'follow_up_file_removed', oldValue: { kind: f.kind, size_bytes: f.size, name: f.name }, newValue: null, source: 'manual' });
      return this.view(tx, agentId, storageOk);
    });
  }

  /** Una URL firmada de pocos minutos para PREVISUALIZAR el archivo (miniatura o descarga). 404 si no es de este agente o ya no existe. */
  async fileUrl(agentId: string, fileId: string): Promise<{ url: string; expires_at: string; kind: string; mime_type: string; filename: string }> {
    await this.agents.runtimeSettings(agentId);
    const f = await this.db.withTenant(async (tx) => {
      const [row] = await tx
        .select({ key: agentFollowUpFiles.storageKey, kind: agentFollowUpFiles.kind, mime: agentFollowUpFiles.mimeType, name: agentFollowUpFiles.filename })
        .from(agentFollowUpFiles)
        .innerJoin(agentFollowUps, and(eq(agentFollowUps.id, agentFollowUpFiles.followUpId), eq(agentFollowUps.organizationId, agentFollowUpFiles.organizationId)))
        .where(and(eq(agentFollowUpFiles.id, fileId), eq(agentFollowUps.agentId, agentId), eq(agentFollowUpFiles.state, 'ready')))
        .limit(1);
      return row ?? null;
    });
    if (!f || !f.key) throw new NotFoundError();
    const signed = await this.files.signedUrl(f.key, f.kind as 'image', f.mime, f.name);
    return { url: signed.url, expires_at: signed.expiresAt.toISOString(), kind: f.kind, mime_type: f.mime, filename: f.name };
  }

  // ------------------------------------------------------------------ validación

  /**
   * Valida los archivos que cada paso pide (`file_ids`) contra lo subido y contra los canales del agente, y devuelve a qué paso y en qué orden quedan. Reglas: solo pasos de texto fijo, hasta 3 por paso,
   * cada archivo en un solo paso y de ESTE agente y sin vencer; GoHighLevel no admite archivos; por WhatsApp oficial un paso con espera acumulada de 24 h o más solo podría enviar una plantilla.
   */
  private async validateFiles(tx: Tx, agentId: string, followUpId: string, input: SetFollowUpsDto): Promise<Map<string, { position: number; order: number }>> {
    const out = new Map<string, { position: number; order: number }>();
    const wanted = input.steps.flatMap((s) => s.file_ids ?? []);
    if (wanted.length === 0) return out;
    if (new Set(wanted).size !== wanted.length) throw new ValidationError([{ path: 'steps', code: 'file_repeated', message: 'Un archivo solo puede estar en un paso' }]);
    const rows = await tx.select({ id: agentFollowUpFiles.id }).from(agentFollowUpFiles).where(and(eq(agentFollowUpFiles.followUpId, followUpId), eq(agentFollowUpFiles.state, 'ready'), inArray(agentFollowUpFiles.id, wanted)));
    if (rows.length !== wanted.length) throw new ValidationError([{ path: 'steps', code: 'file_not_found', message: 'Alguno de los archivos ya no existe o venció: súbelo de nuevo' }]);
    const channels = await this.channelsOf(tx, agentId);
    if (channels.ghl) throw new ConflictError('FOLLOW_UP_FILES_GHL', FILES_GHL_MESSAGE);
    const cumulative = cumulativeMinutes(input.steps.map((s) => s.delay_minutes));
    input.steps.forEach((s, i) => {
      const ids = s.file_ids ?? [];
      if (ids.length === 0) return;
      if (s.mode !== 'fixed_text') throw new ValidationError([{ path: `steps.${i}.file_ids`, code: 'files_need_fixed_text', message: 'Solo los pasos con texto fijo pueden llevar archivos (la IA no elige archivos)' }]);
      if (ids.length > MAX_FILES_PER_STEP) throw new ValidationError([{ path: `steps.${i}.file_ids`, code: 'too_many_files', message: `Un paso lleva hasta ${MAX_FILES_PER_STEP} archivos` }]);
      if (channels.official && !insideOfficialWindow(cumulative[i]!)) throw new ConflictError('FOLLOW_UP_FILES_OUTSIDE_WINDOW', FILES_OUTSIDE_WINDOW_MESSAGE);
      ids.forEach((id, k) => out.set(id, { position: i + 1, order: k }));
    });
    return out;
  }

  /** Asigna cada archivo a su paso y orden. Lo que estaba en un paso y ya no está en ninguno vence (la tarea borra el objeto); lo recién subido sin asignar espera 24 h por si se asigna en otro guardado. */
  private async applyAssignments(tx: Tx, followUpId: string, assignments: Map<string, { position: number; order: number }>): Promise<void> {
    const now = new Date();
    const ready = and(eq(agentFollowUpFiles.followUpId, followUpId), eq(agentFollowUpFiles.state, 'ready'));
    const wasAssigned = (await tx.select({ id: agentFollowUpFiles.id }).from(agentFollowUpFiles).where(and(ready, sql`${agentFollowUpFiles.stepPosition} IS NOT NULL`))).map((r) => r.id);
    // Primero se sueltan todos (el índice único de la ranura no admite dos en el mismo lugar a la vez) y luego se asigna
    await tx.update(agentFollowUpFiles).set({ stepPosition: null, updatedAt: now }).where(ready);
    for (const [id, a] of assignments) await tx.update(agentFollowUpFiles).set({ stepPosition: a.position, sortOrder: a.order, updatedAt: now }).where(eq(agentFollowUpFiles.id, id));
    const dropped = wasAssigned.filter((id) => !assignments.has(id));
    if (dropped.length > 0) await tx.update(agentFollowUpFiles).set({ state: 'expired', updatedAt: now }).where(inArray(agentFollowUpFiles.id, dropped));
  }

  /** Los tipos de conexión que atiende el agente: oficial (con ventana de 24 h), QR (sin ventana) y GoHighLevel (solo texto). */
  private async channelsOf(tx: Tx, agentId: string): Promise<{ official: boolean; qr: boolean; ghl: boolean }> {
    const rows = await tx
      .select({ provider: channelAccounts.provider })
      .from(agentChannels)
      .innerJoin(channelAccounts, and(eq(channelAccounts.id, agentChannels.channelId), eq(channelAccounts.organizationId, agentChannels.organizationId)))
      .where(eq(agentChannels.agentId, agentId));
    const providers = new Set(rows.map((r) => r.provider));
    return { official: providers.has('meta_cloud'), qr: providers.has('evolution'), ghl: providers.has('ghl') };
  }

  /** Los textos fijos solo pueden llevar las variables permitidas (se rechaza lo demás antes de guardar). */
  private validateTexts(input: SetFollowUpsDto): void {
    input.steps.forEach((s, i) => {
      if (s.mode !== 'fixed_text' || !s.fixed_text) return;
      const bad = disallowedVariables(variablesIn(s.fixed_text));
      if (bad.length > 0) throw new ValidationError([{ path: `steps.${i}.fixed_text`, code: 'variable_not_allowed', message: `Variables no permitidas: ${bad.map((b) => `{{${b}}}`).join(', ')}. Usa solo ${FOLLOW_UP_VARIABLES.map((v) => `{{${v}}}`).join(', ')}` }]);
    });
  }

  private async view(tx: Tx, agentId: string, storageOk: boolean): Promise<FollowUpsView> {
    const [fu] = await tx.select().from(agentFollowUps).where(and(eq(agentFollowUps.agentId, agentId), eq(agentFollowUps.scenario, SCENARIO))).limit(1);
    const steps = fu ? await tx.select().from(agentFollowUpSteps).where(eq(agentFollowUpSteps.followUpId, fu.id)).orderBy(asc(agentFollowUpSteps.position)) : [];
    const fileRows = fu ? await tx.select().from(agentFollowUpFiles).where(and(eq(agentFollowUpFiles.followUpId, fu.id), eq(agentFollowUpFiles.state, 'ready'))).orderBy(asc(agentFollowUpFiles.sortOrder), asc(agentFollowUpFiles.createdAt)) : [];
    const autos = await tx.select({ id: automations.id, name: automations.name }).from(automations).where(and(eq(automations.status, 'active'), isNull(automations.deletedAt))).orderBy(asc(automations.name)).limit(100);
    const recent = await tx
      .select({ status: agentFollowUpRuns.status, reason: agentFollowUpRuns.reason, n: sql<number>`count(*)::int` })
      .from(agentFollowUpRuns)
      .where(and(eq(agentFollowUpRuns.agentId, agentId), gt(agentFollowUpRuns.createdAt, new Date(Date.now() - 7 * 86_400_000))))
      .groupBy(agentFollowUpRuns.status, agentFollowUpRuns.reason)
      .orderBy(desc(sql`count(*)`));
    const summary = { sent: 0, skipped: 0, cancelled: 0, pending: 0, reasons: {} as Record<string, number> };
    for (const r of recent) {
      summary[r.status as 'sent' | 'skipped' | 'cancelled' | 'pending'] += r.n;
      if (r.reason) summary.reasons[r.reason] = (summary.reasons[r.reason] ?? 0) + r.n;
    }
    const channels = await this.channelsOf(tx, agentId);
    return {
      scenario: SCENARIO,
      enabled: fu?.enabled ?? false,
      steps: steps.map((s) => ({
        position: s.position,
        delay_minutes: s.delayMinutes,
        mode: s.mode as 'ai' | 'fixed_text' | 'none',
        fixed_text: s.fixedText,
        start_automation_id: s.startAutomationId,
        files: fileRows.filter((f) => f.stepPosition === s.position).map(fileView),
      })),
      loose_files: fileRows.filter((f) => f.stepPosition === null).map(fileView),
      files_storage: { files: fileRows.length, bytes: fileRows.reduce((n, f) => n + f.sizeBytes, 0), available: storageOk, limits: { max_per_step: MAX_FILES_PER_STEP, max_mb: { image: MAX_BYTES.image / 1048576, video: MAX_BYTES.video / 1048576, audio: MAX_BYTES.audio / 1048576, document: MAX_BYTES.document / 1048576 } } },
      channels,
      variables: [...FOLLOW_UP_VARIABLES],
      automations: autos,
      summary,
      updated_at: fu?.updatedAt.toISOString() ?? null,
    };
  }
}

const fileView = (f: typeof agentFollowUpFiles.$inferSelect): FollowUpFileView => ({
  id: f.id,
  kind: f.kind as FollowUpFileView['kind'],
  mime_type: f.mimeType,
  filename: f.filename,
  size_bytes: f.sizeBytes,
  scan_status: f.scanStatus as 'clean' | 'skipped',
  step_position: f.stepPosition,
  sort_order: f.sortOrder,
});
