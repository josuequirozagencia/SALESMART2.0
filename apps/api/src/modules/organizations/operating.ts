import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { organizations } from '../../db';

/**
 * «La empresa está operando»: activa y no eliminada. Es el ÚNICO filtro con el que las tareas periódicas eligen a qué empresas atender (ADR-59 #4): las cuatro enumeraciones
 * (`OrgDirectoryService.clientOrganizationIds`, `AttributionEndpointsService.activeClientOrgIds`, y las rutas de canales/QR/GoHighLevel) lo aplican. Una empresa suspendida o
 * eliminada deja de procesar, enviar y gastar créditos sin tocar las tareas una por una; al recuperarla vuelve a salir en la lista y lo que quedó guardado se procesa.
 */
export const operatingOrg = (): SQL => and(eq(organizations.status, 'active'), isNull(organizations.deletedAt)) as SQL;
