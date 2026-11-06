import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { chatBgKey, chatBgPaint, DEFAULT_CHAT_BG, parseChatBg } from '../src/ui/chatBackground';
import { setBrand } from '../src/ui/brand';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld } from './helpers';

beforeEach(() => {
  resetWorld();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  setBrand('indigo');
});

describe('fondo del chat (modelo)', () => {
  it('lo guardado se valida: basura o valores desconocidos dan el predeterminado', () => {
    expect(parseChatBg(null)).toEqual(DEFAULT_CHAT_BG);
    expect(parseChatBg('{no es json')).toEqual(DEFAULT_CHAT_BG);
    expect(parseChatBg('[]')).toEqual(DEFAULT_CHAT_BG);
    expect(parseChatBg(JSON.stringify({ kind: 'foto', color: 'x' }))).toEqual(DEFAULT_CHAT_BG);
    expect(parseChatBg(JSON.stringify({ kind: 'color', color: 'rosa' }))).toEqual({ kind: 'color', color: 'rosa' });
  });

  it('cada opción se pinta distinto: patrón, liso, color y ninguno', () => {
    expect(chatBgPaint({ kind: 'default', color: 'gris' }).className).toBe('chat-bg-pattern');
    expect(chatBgPaint({ kind: 'plain', color: 'gris' })).toEqual({ className: '', style: { backgroundColor: 'var(--chat-bg)' } });
    expect(chatBgPaint({ kind: 'none', color: 'gris' }).style.backgroundColor).toBe('var(--bg)');
    expect(String(chatBgPaint({ kind: 'color', color: 'azul' }).style.backgroundColor)).toContain('#3b82f6');
  });

  it('la clave es por persona y empresa', () => {
    expect(chatBgKey('u1', 'o1')).not.toBe(chatBgKey('u1', 'o2'));
    expect(chatBgKey('u1', 'o1')).not.toBe(chatBgKey('u2', 'o1'));
  });
});

describe('Configuración › Apariencia', () => {
  it('cuatro temas (incluido WhatsApp), fondo del chat con vista previa, y lo elegido se conserva', async () => {
    mockApi(authed(ME_ADMIN));
    const first = renderApp('/settings/appearance');
    const temas = await screen.findByRole('radiogroup', { name: 'Tema' });
    expect(temas.querySelectorAll('[role=radio]')).toHaveLength(4);
    await userEvent.click(within(temas).getByRole('radio', { name: /WhatsApp/ }));
    expect(document.documentElement.getAttribute('data-brand')).toBe('whatsapp');

    const fondo = screen.getByRole('radiogroup', { name: 'Fondo del chat' });
    expect(within(fondo).getByRole('radio', { name: /Predeterminado/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('img', { name: 'Vista previa del chat' })).toHaveClass('chat-bg-pattern');
    await userEvent.click(within(fondo).getByRole('radio', { name: /Color/ }));
    const colores = screen.getByRole('radiogroup', { name: 'Color del fondo' });
    expect(colores.querySelectorAll('[role=radio]')).toHaveLength(6);
    await userEvent.click(within(colores).getByRole('radio', { name: /Rosa/ }));
    expect(screen.getByRole('img', { name: 'Vista previa del chat' })).not.toHaveClass('chat-bg-pattern');
    expect(JSON.parse(window.localStorage.getItem(chatBgKey('u1', 'o1')) ?? '{}')).toEqual({ kind: 'color', color: 'rosa' });

    // Al volver a abrir la aplicación la elección sigue ahí
    first.unmount();
    renderApp('/settings/appearance');
    const fondo2 = await screen.findByRole('radiogroup', { name: 'Fondo del chat' });
    expect(within(fondo2).getByRole('radio', { name: /Color/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByRole('radiogroup', { name: 'Color del fondo' })).getByRole('radio', { name: /Rosa/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('el botón de modo de la barra superior solo tiene icono y cambia todo el sistema', async () => {
    mockApi(authed(ME_ADMIN));
    renderApp('/settings/appearance');
    const btn = await screen.findByRole('button', { name: 'Cambiar a modo oscuro' });
    expect(btn.textContent?.trim()).toBe('');
    await userEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Cambiar a modo claro' })).toBeInTheDocument();
  });
});
