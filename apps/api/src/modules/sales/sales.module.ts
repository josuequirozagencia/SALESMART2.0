import { Module } from '@nestjs/common';
import { AttributionModule } from '../attribution';
import { EventsModule } from '../events';
import { NotificationsModule } from '../notifications';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { PushModule } from '../push';
import { RealtimeModule } from '../realtime';
import { SlaModule } from '../sla';
import { SalesController } from './sales.controller';
import { SaleNoticesService } from './sale-notices.service';
import { SalesService } from './sales.service';

/** Ventas, abonos y saldo (M6.2, ADR-08/51). Al vender: etiqueta Venta y Purchase a Meta (atribución), oportunidad ganada y SLA detenido. */
@Module({
  imports: [AttributionModule.register(), EventsModule, NotificationsModule, OpportunitiesModule, OrganizationsModule, PushModule, RealtimeModule, SlaModule],
  controllers: [SalesController],
  providers: [SalesService, SaleNoticesService],
  exports: [SalesService],
})
export class SalesModule {}
