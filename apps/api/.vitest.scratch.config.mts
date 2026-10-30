// TEMPORAL (no se versiona): igual que vitest.config.mts pero transpila con TypeScript en lugar de SWC.
import path from 'node:path';
import ts from 'typescript';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'ts-transpile-decorators',
      enforce: 'pre',
      transform(code: string, id: string) {
        const file = id.split('?')[0]!;
        if (!file.endsWith('.ts') || file.includes('node_modules')) return null;
        const out = ts.transpileModule(code, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true, emitDecoratorMetadata: true, sourceMap: true, esModuleInterop: true } });
        return { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
      },
    },
  ],
  resolve: { alias: { '@sales-smart/shared': path.resolve(import.meta.dirname, '../../packages/shared/src/index.ts') } },
  test: { environment: 'node', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', 'node_modules/**'], globalSetup: ['.global-setup.scratch.ts'], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
