// El compilador impide fabricar o confundir transacciones (ADR-24 P9). Control negativo: sin @ts-expect-error debe fallar.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../.tmp-types');
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function diagnose(name: string, body: string): string[] {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    `import type { TenantTx, PlatformTx } from '../../src/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
declare const t: TenantTx; declare const p: PlatformTx; declare const raw: NodePgDatabase;
export function repo(_tx: TenantTx): void {}
export function plat(_tx: PlatformTx): void {}
${body}
`,
  );
  const cfgPath = path.resolve(__dirname, '../../tsconfig.json');
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, path.dirname(cfgPath));
  const program = ts.createProgram([file], { ...cfg.options, noEmit: true });
  return ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('tipos: TenantTx / PlatformTx no se fabrican ni se confunden', () => {
  it('los usos prohibidos son errores de compilación (cada @ts-expect-error se cumple)', () => {
    const errs = diagnose('negativos.ts', `
repo(t);
plat(p);
// @ts-expect-error PlatformTx no es TenantTx
repo(p);
// @ts-expect-error TenantTx no es PlatformTx
plat(t);
// @ts-expect-error una instancia drizzle cruda no es TenantTx
repo(raw);
// @ts-expect-error un objeto literal no es TenantTx
repo({});
// @ts-expect-error no se puede fabricar con una variable tipada como NodePgDatabase
const x: TenantTx = raw; void x;
`);
    expect(errs).toEqual([]);
  });

  it('control negativo: sin @ts-expect-error el compilador SÍ reporta los 5 errores (la prueba tiene dientes)', () => {
    const errs = diagnose('control.ts', `
repo(p);
plat(t);
repo(raw);
repo({});
const x: TenantTx = raw; void x;
`);
    expect(errs.length).toBe(5);
  });
});
