import path from 'node:path';
import ts from 'typescript';
import { defineConfig } from 'vitest/config';
const tsPlugin = {
  name: 'ts-decorators',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!/\.ts$/.test(id) || id.includes('node_modules')) return null;
    const out = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true, emitDecoratorMetadata: true, sourceMap: true, useDefineForClassFields: false }, fileName: id });
    return { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
  },
};
export default defineConfig({
  plugins: [tsPlugin],
  resolve: { alias: { '@sales-smart/shared': path.resolve(import.meta.dirname, '../../packages/shared/src/index.ts') } },
  test: { environment: 'node', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', 'node_modules/**'], globalSetup: ['test/support/global-setup.local.ts'], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
