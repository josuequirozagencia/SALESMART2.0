import { defineConfig } from 'vitest/config';

// e2e: arranca el artefacto COMPILADO (dist/main.js) como proceso real contra una BD migrada. Requiere `pnpm build`.
export default defineConfig({
  test: { environment: 'node', include: ['test/e2e/**/*.e2e.test.ts'], globalSetup: ['test/support/global-setup.ts'], testTimeout: 60_000, hookTimeout: 90_000, fileParallelism: false },
});
