import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '@sales-smart/shared';
import { Database } from '../../db';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CustomValuesService } from '../custom-fields';
import { exportCell, FIXED_EXPORT, type ExportDto } from './contact-export';
import { ContactsService, type ContactScope } from './contacts.service';
import { csvFile } from './csv';

/**
 * Exportación de contactos a CSV (M3.5, ADR-47 #8). Lee y AUDITA en la misma transacción: no hay descarga sin rastro. El permiso (`contacts.export`) lo exige el
 * controlador; el alcance por persona lo aplica `ContactsService` igual que en el listado.
 */
@Injectable()
export class ContactExportService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
  ) {}

  async export(scope: ContactScope, q: ExportDto): Promise<{ filename: string; csv: string; count: number }> {
    // Se lee y se audita en UNA transacción (no hay descarga sin rastro); los nombres de los responsables viven en identidad y se resuelven después, fuera de ella
    const { bundle, used } = await this.db.withTenant(async (tx) => {
      const fields = await this.custom.labels(tx, 'contact');
      const catalog = [...FIXED_EXPORT, ...fields.map((f) => ({ key: `cf:${f.key}`, label: f.name }))];
      const wanted = q.columns ?? catalog.map((c) => c.key);
      const columns = catalog.filter((c) => wanted.includes(c.key));
      // Una columna de un campo que ya no existe se ignora; si no queda ninguna válida, se exporta todo
      const used = columns.length > 0 ? columns : catalog;
      const bundle = await this.contacts.exportRowsIn(tx, scope, q);
      await writeAudit(tx, {
        entityType: 'contact_export',
        entityId: uuidv7(),
        newValue: {
          scope: q.scope,
          count: bundle.rows.length,
          columns: used.map((c) => c.key),
          ...(q.scope === 'view' ? { filters: { q: q.q ?? null, owner: q.owner ?? null, source: q.source ?? null, consent: q.consent ?? null, tag: q.tag ?? [], cf: q.cf ?? [], list: q.list ?? null } } : {}),
          ...(q.scope === 'selection' ? { selected: q.ids?.length ?? 0 } : {}),
          by: TenantContext.current().userId ?? null,
        },
        source: 'manual',
      });
      return { bundle, used };
    });
    const rows = await this.contacts.exportViews(bundle);
    const csv = csvFile([used.map((c) => c.label), ...rows.map((r) => used.map((c) => exportCell(r, c.key)))]);
    const day = new Date().toISOString().slice(0, 10);
    return { filename: `contactos-${day}.csv`, csv, count: rows.length };
  }
}
