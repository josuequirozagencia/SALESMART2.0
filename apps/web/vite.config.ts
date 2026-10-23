import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En desarrollo la web y la API comparten origen vía proxy: la cookie de refresh (HttpOnly, SameSite=Strict, Path=/v1/auth)
// funciona igual que en producción detrás de un único dominio.
const api = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/v1': { target: api, ws: true } } },
  preview: { port: 4173, proxy: { '/v1': { target: api, ws: true } } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    // Los runners de CI son más lentos que un equipo de desarrollo: pruebas con tablas grandes (501 filas) pasaban de los 5 s por defecto
    testTimeout: 20_000,
  },
});
