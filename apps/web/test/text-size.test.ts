import { afterEach, describe, expect, it } from 'vitest';
import { TEXT_SIZE_KEY, applyTextSize, parseTextSize, readTextSize, setTextSize } from '../src/ui/textSize';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-text');
});

describe('Tamaño del texto en escritorio (v11)', () => {
  it('sin elección guardada es «Compacto»; solo «comfortable» cambia', () => {
    expect(parseTextSize(null)).toBe('compact');
    expect(parseTextSize('compact')).toBe('compact');
    expect(parseTextSize('lo que sea')).toBe('compact');
    expect(parseTextSize('comfortable')).toBe('comfortable');
    expect(readTextSize()).toBe('compact');
  });

  it('«Cómodo» marca <html data-text="comfortable"> y se guarda; «Compacto» lo quita y borra la preferencia', () => {
    setTextSize('comfortable');
    expect(document.documentElement.getAttribute('data-text')).toBe('comfortable');
    expect(window.localStorage.getItem(TEXT_SIZE_KEY)).toBe('comfortable');
    expect(readTextSize()).toBe('comfortable');
    setTextSize('compact');
    expect(document.documentElement.hasAttribute('data-text')).toBe(false);
    expect(window.localStorage.getItem(TEXT_SIZE_KEY)).toBeNull();
  });

  it('applyTextSize no toca el almacenamiento', () => {
    applyTextSize('comfortable');
    expect(document.documentElement.getAttribute('data-text')).toBe('comfortable');
    expect(window.localStorage.getItem(TEXT_SIZE_KEY)).toBeNull();
  });
});
