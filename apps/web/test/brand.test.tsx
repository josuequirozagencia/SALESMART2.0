import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppearancePage } from '../src/features/settings/AppearancePage';
import { BRAND_KEY, applyBrand, parseBrand, setBrand } from '../src/ui/brand';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-brand');
  setBrand('indigo');
});

describe('tema de marca', () => {
  it('solo verde y rojo son marcas distintas; cualquier otra cosa es índigo', () => {
    expect(parseBrand('green')).toBe('green');
    expect(parseBrand('red')).toBe('red');
    expect(parseBrand('azul')).toBe('indigo');
    expect(parseBrand(null)).toBe('indigo');
  });

  it('elegir guarda y pone data-brand; el índigo quita ambos', () => {
    setBrand('green');
    expect(document.documentElement.getAttribute('data-brand')).toBe('green');
    expect(window.localStorage.getItem(BRAND_KEY)).toBe('green');
    setBrand('indigo');
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
    expect(window.localStorage.getItem(BRAND_KEY)).toBeNull();
    applyBrand('red');
    expect(document.documentElement.getAttribute('data-brand')).toBe('red');
  });

  it('el script previo al primer pintado usa la misma clave', () => {
    expect(readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8')).toContain(BRAND_KEY);
  });

  it('Configuración › Apariencia: tres colores en un grupo de opciones y el elegido queda marcado', async () => {
    render(<MemoryRouter><AppearancePage /></MemoryRouter>);
    const group = screen.getByRole('radiogroup', { name: 'Color de la marca' });
    expect(group.querySelectorAll('[role=radio]')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Índigo/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: /Verde/ }));
    expect(screen.getByRole('radio', { name: /Verde/ })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.getAttribute('data-brand')).toBe('green');
  });
});
