import swc from 'unplugin-swc';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // swc: soporte de decoradores + metadata (Nest) en los tests
  plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  resolve: { alias: { '@sales-smart/shared': path.resolve(import.meta.dirname, '../../packages/shared/src/index.ts') } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
