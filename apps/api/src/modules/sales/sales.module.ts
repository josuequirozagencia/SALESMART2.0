import { Module } from '@nestjs/common';
import { AttributionModule } from '../attribution';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { RealtimeModule } from '../realtime';
import { SlaModule } from '../sla';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/** Ventas, abonos y saldo (M6.2, ADR-08/51). Al vender: etiqueta Venta y Purchase a Meta (atribución), oportunidad ganada y SLA detenido. */
@Module({
  imports: [AttributionModule.register(), OpportunitiesModule, OrganizationsModule, RealtimeModule, SlaModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
