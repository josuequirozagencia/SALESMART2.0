import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Con toda la suite en paralelo (y en los runners de CI) 1 s se queda corto para findBy*/waitFor: no es un fallo de la app
configure({ asyncUtilTimeout: 4000 });
afterEach(() => cleanup());

// La conexión en vivo del Inbox no abre red en las pruebas: `fake-socket` la sustituye y cada prueba decide qué llega
vi.mock('socket.io-client', async () => {
  const m = await import('./fake-socket');
  return { io: m.fakeIo };
});
