import { Controller, Get, Header } from '@nestjs/common';
import { FORM_EMBED_SCRIPT } from '@sales-smart/shared';
import { Public } from '../../http';

/**
 * El código del formulario embebible (M9.2, ADR-09/54): `GET /v1/embed/v1.js`. PÚBLICO y estático (el mismo para todas las empresas: nada de datos). La versión va en la dirección: un cambio
 * que rompa la compatibilidad sería `v2.js`, y las páginas que ya incrustan `v1.js` siguen funcionando. Se puede guardar unos minutos en el navegador y en intermediarios; `nosniff` y
 * `cross-origin` para que cualquier página pueda cargarlo con una etiqueta `<script>`.
 */
@Public()
@Controller('embed')
export class FormsEmbedController {
  @Get('v1.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  script(): string {
    return FORM_EMBED_SCRIPT;
  }
}
