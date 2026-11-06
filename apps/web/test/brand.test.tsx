import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BRAND_KEY, applyBrand, parseBrand, setBrand } from '../src/ui/brand';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-brand');
  setBrand('indigo');
});

describe('tema de marca', () => {
  it('verde, rojo y WhatsApp son marcas distintas; cualquier otra cosa es índigo', () => {
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

  it('WhatsApp es una marca más', () => {
    expect(parseBrand('whatsapp')).toBe('whatsapp');
    setBrand('whatsapp');
    expect(document.documentElement.getAttribute('data-brand')).toBe('whatsapp');
    expect(readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8')).toContain('whatsapp');
  });
});
