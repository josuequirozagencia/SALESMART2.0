import { defineConfig } from '@playwright/test';

/**
 * E2E del flujo de acceso en un navegador real contra la API COMPILADA (apps/api/dist) y la web compilada, con una base
 * de datos efímera. Requiere `pnpm build` y `TEST_PG_ADMIN_URL` (superusuario de un PostgreSQL desechable).
 * globalSetup arranca y detiene todo (BD, API, web). `PW_CHANNEL=msedge|chrome` usa un navegador ya instalado.
 */
const webPort = Number(process.env['E2E_WEB_PORT'] ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    ...(process.env['PW_CHANNEL'] ? { channel: process.env['PW_CHANNEL'] } : {}),
    locale: 'es-EC',
    trace: 'retain-on-failure',
  },
});
