// F3a (ADR-59 #4): una empresa suspendida o eliminada deja de ser atendida por TODAS las tareas periódicas porque todas eligen a sus empresas con una de las enumeraciones
// centrales, y esas aplican `operatingOrg`. Estas pruebas leen el código fuente: una tarea nueva que recorra empresas por otro camino (o una enumeración a la que le quiten
// el filtro) hace fallar la CI en vez de seguir procesando una empresa eliminada.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8');

/** Tareas que NO recorren empresas de negocio, con el motivo. Cualquier otra tarea debe usar una enumeración central. */
const EXEMPT: Record<string, string> = {
  'modules/auth/identity-cleanup.job.ts': 'limpia tablas de identidad (sesiones, códigos, intentos): no atiende a ninguna empresa',
  'modules/organizations/trial-expiry.job.ts': 'vence pruebas en la tabla de identidad; no envía ni procesa nada de la empresa',
  'modules/company-export/company-export.job.ts': 'atiende pedidos concretos de la copia de datos de UNA empresa eliminada dentro de su plazo (el único caso en que se lee una empresa detenida) y borra paquetes vencidos; no recorre empresas',
};
const ENUMERATION = /\.(clientOrganizationIds|activeClientOrgIds|organizationIds)\(\)/;

describe('tareas periódicas y empresas detenidas', () => {
  const jobs = walk(path.join(SRC, 'modules'))
    .filter((f) => f.endsWith('.job.ts'))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'));

  it('hay tareas que revisar (el barrido encuentra los archivos)', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(17);
  });

  it('toda tarea que recorre empresas lo hace con una enumeración central; las exentas están justificadas y no recorren empresas', () => {
    for (const job of jobs) {
      const code = read(job);
      if (EXEMPT[job]) {
        expect(code, `${job} figura como exenta pero recorre empresas`).not.toMatch(ENUMERATION);
        expect(code, `${job} figura como exenta pero abre contexto de empresa`).not.toContain('TenantContext.run');
      } else {
        expect(code, `${job}: no usa una enumeración de empresas (clientOrganizationIds, activeClientOrgIds u organizationIds): una empresa eliminada seguiría procesándose`).toMatch(ENUMERATION);
      }
    }
  });

  it('ninguna tarea consulta la tabla de organizaciones por su cuenta', () => {
    for (const job of jobs) expect(read(job), job).not.toMatch(/from\(organizations\)|FROM organizations/i);
  });

  it('las cuatro enumeraciones centrales aplican el filtro `operatingOrg` (activa y no eliminada)', () => {
    const files: Array<[string, string]> = [
      ['modules/organizations/org-directory.service.ts', 'clientOrganizationIds'],
      ['modules/organizations/attribution-endpoints.service.ts', 'activeClientOrgIds'],
      ['modules/organizations/channel-routes.service.ts', 'organizationIds'],
      ['modules/organizations/qr-routes.service.ts', 'organizationIds'],
      ['modules/organizations/ghl-routes.service.ts', 'organizationIds'],
    ];
    for (const [file, method] of files) {
      const code = read(file);
      const start = code.indexOf(`async ${method}(`);
      expect(start, `${file}: no se encontró ${method}`).toBeGreaterThan(-1);
      const end = code.indexOf('\n  }\n', start);
      expect(code.slice(start, end), `${file}: ${method} debe filtrar con operatingOrg()`).toContain('operatingOrg()');
    }
  });

  it('`operatingOrg` exige estado activo y sin fecha de eliminación', () => {
    const code = read('modules/organizations/operating.ts');
    expect(code).toContain("eq(organizations.status, 'active')");
    expect(code).toContain('isNull(organizations.deletedAt)');
  });
});
