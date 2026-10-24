import { Inject, Injectable } from '@nestjs/common';
import { Database, ghlConnections } from '../../db';
import { NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { GhlRoutesService } from '../organizations';
import { dedupeKeyOf, normalizeGhlPayload } from './ghl-event';
import { GhlEventsService } from './ghl-events.service';

/**
 * Entrada del webhook de GoHighLevel (M7.2, ADR-52). PÚBLICA: no hay sesión. La credencial es el par (identificador opaco de la URL + secreto en la cabecera `X-Webhook-Secret`); la empresa
 * sale de ahí, nunca del cuerpo. Un identificador desconocido, un secreto equivocado o ausente, y una empresa sin conexión (o desconectada) responden lo mismo (404). Ya autenticado,
 * un cuerpo que no cumple el contrato da 400 con el detalle (sirve para armar el Workflow). Solo VALIDA y GUARDA: el proceso lo hace la tarea.
 */
@Injectable()
export class GhlWebhookService {
  constructor(
    @Inject(GhlRoutesService) private readonly routes: GhlRoutesService,
    @Inject(Database) private readonly db: Database,
    @Inject(GhlEventsService) private readonly events: GhlEventsService,
  ) {}

  async ingest(routeId: string, secret: string | undefined, body: unknown, now = new Date()): Promise<{ stored: boolean }> {
    const organizationId = secret ? await this.routes.resolve(routeId, secret) : null;
    if (!organizationId) throw new NotFoundError();
    return TenantContext.run({ organizationId }, async () => {
      const parsed = normalizeGhlPayload(body);
      // Sin conexión (o desconectada) no hay a dónde llevar el aviso: se trata como si el punto de entrada no existiera. Un token rechazado NO impide recibir (entrar no usa el token)
      const conn = await this.db.withTenant(async (tx) => (await tx.select({ locationId: ghlConnections.locationId, status: ghlConnections.status }).from(ghlConnections).limit(1))[0] ?? null);
      if (!conn || conn.status === 'disconnected') throw new NotFoundError();
      if (!parsed.ok) throw new ValidationError(parsed.issues);
      const e = parsed.event;
      // Un aviso de OTRA Location no es de esta empresa: señal de un Workflow mal conectado
      if (e.locationId && e.locationId !== conn.locationId) throw new ValidationError([{ path: 'location.id', code: 'location_mismatch', message: 'El aviso es de otra Location de GoHighLevel que la conectada' }]);
      const stored = await this.db.withTenant((tx) => this.events.store(tx, e, dedupeKeyOf(e, now), now));
      return { stored };
    });
  }
}
