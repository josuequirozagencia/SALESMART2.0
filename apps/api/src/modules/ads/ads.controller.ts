import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { AdsService } from './ads.service';

const ids = z
  .string()
  .min(1)
  .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter((x) => x !== ''))])
  .pipe(z.array(z.string().regex(/^[0-9A-Za-z_-]{1,100}$/)).min(1).max(50));
const querySchema = z.strictObject({ ids });
type AdsQuery = z.output<typeof querySchema>;

/**
 * Anuncios de Meta de la empresa (v20, ADR-55): `GET /v1/ads/creatives?ids=a,b,c` (hasta 50) da, por id de anuncio, su titular, texto, dirección, red y la dirección firmada de su miniatura. Lo usan la ficha del
 * contacto y el reporte «Anuncio ganador». Quien puede ver contactos lo puede ver (el anuncio de origen ya está en la ficha). Siempre `no-store`: las direcciones firmadas caducan.
 */
@RequirePermission('contacts.read')
@Controller('ads')
export class AdsController {
  constructor(@Inject(AdsService) private readonly ads: AdsService) {}

  @Get('creatives')
  @Header('Cache-Control', 'no-store')
  async creatives(@Query(new ZodValidationPipe(querySchema)) q: AdsQuery) {
    return { items: await this.ads.resolve(q.ids) };
  }
}
