import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { NotificationsService } from '../notifications';
import { OrgMembersService } from '../organizations';
import { PushService } from '../push';
import { RealtimeService } from '../realtime';

/** Lo que el aviso de una venta nueva necesita saber de ella. */
export interface SaleNoticeInput {
  saleId: string;
  /** Quien la registró: no se le avisa a sí mismo. */
  authorId: string;
  seller: string;
  contact: string;
  amount: string;
  currency: string;
}

/**
 * «Nueva venta: {vendedor} · {monto} · {contacto}» para la administración de ESA empresa (v13 S4.2). Se dispara DESPUÉS de confirmar la venta (nunca dentro de su transacción) y solo cuando la
 * venta es nueva: una repetición con la misma `Idempotency-Key` no pasa por aquí, y el índice único de avisos (un aviso por persona y venta) lo garantiza aunque dos peticiones lleguen a la vez.
 * Los destinatarios son los miembros vigentes con rol `client_admin` de la empresa del contexto, menos quien la registró; un asesor jamás recibe avisos de ventas. El aviso queda en la campana
 * (y llega en vivo a quien tenga la aplicación abierta) y, si la persona activó las notificaciones del navegador, también como notificación del sistema. Mejor esfuerzo: un fallo aquí se registra y
 * NO afecta a la venta (que ya está guardada).
 */
@Injectable()
export class SaleNoticesService {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
    @Optional() @Inject(PushService) private readonly push?: PushService,
  ) {}

  async created(n: SaleNoticeInput): Promise<void> {
    try {
      const org = TenantContext.current().organizationId;
      const admins = (await this.members.assignable()).filter((p) => p.role === 'client_admin' && p.id !== n.authorId).map((p) => p.id);
      if (admins.length === 0) return;
      const notices = await this.notifications.recordSaleCreated({ saleId: n.saleId, actorId: n.authorId, recipients: admins });
      if (notices.length === 0) return;
      this.realtime?.notify(org, notices);
      const amount = new Intl.NumberFormat('es-EC', { style: 'currency', currency: n.currency }).format(Number(n.amount));
      await this.push?.notifySale(notices.map((x) => x.userId), { saleId: n.saleId, seller: n.seller, amount, contact: n.contact });
    } catch (e) {
      this.log.warn({ sale_id: n.saleId, err: e instanceof Error ? e.name : 'Error' }, 'no se pudo avisar de una venta nueva');
    }
  }
}
