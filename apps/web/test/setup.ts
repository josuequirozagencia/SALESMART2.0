import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Con toda la suite en paralelo (y en los runners de CI) 1 s se queda corto para findBy*/waitFor: no es un fallo de la app
configure({ asyncUtilTimeout: 4000 });
afterEach(() => cleanup());
