// TEMPORAL (no se versiona): execFileSync('pnpm') no resuelve pnpm.cmd en Windows; se reemplaza por node + drizzle-kit.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const orig = cp.execFileSync;
const slash = (a: string): string => a.split('\\').join('/');
(cp as { execFileSync: unknown }).execFileSync = ((file: string, args: string[], opts: object) =>
  file === 'pnpm' && args[0] === 'exec' && args[1] === 'drizzle-kit'
    ? orig(process.execPath, [path.resolve(__dirname, 'node_modules/drizzle-kit/bin.cjs'), ...args.slice(2).map(slash)], opts)
    : orig(file, args, opts)) as typeof cp.execFileSync;
syncBuiltinESMExports();

export { default } from './test/support/global-setup';
