import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatBgKey, chatBgPaint, DEFAULT_CHAT_BG, parseChatBg } from '../src/ui/chatBackground';
import { setBrand } from '../src/ui/brand';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld } from './helpers';

const toBg = vi.hoisted(() => vi.fn());
vi.mock('../src/ui/chatBackgroundImage', () => ({ fileToChatBackground: toBg, MAX_ORIGINAL_BYTES: 8 * 1024 * 1024 }));

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

describe('fondo del chat · patrón propio, galería e imagen (v6 fase F)', () => {
  it('el patrón WhatsApp y el liso WhatsApp usan el color de WhatsApp; la galería y la imagen se pintan', () => {
    expect(chatBgPaint({ kind: 'wapattern', color: 'gris' })).toEqual({ className: 'chat-bg-wa', style: { backgroundColor: 'var(--wa-bg)' } });
    expect(chatBgPaint({ kind: 'wa', color: 'gris' })).toEqual({ className: '', style: { backgroundColor: 'var(--wa-bg)' } });
    expect(chatBgPaint({ kind: 'gallery', color: 'gris', gallery: 'dots' }).className).toBe('chat-bg-g-dots');
    const img = 'data:image/jpeg;base64,AAAA';
    expect(String(chatBgPaint({ kind: 'image', color: 'gris', image: img }).style.backgroundImage)).toContain(img);
    expect(chatBgPaint({ kind: 'image', color: 'gris' }).className).toBe('chat-bg-pattern'); // sin imagen: el predeterminado
  });

  it('lo guardado valida la galería y la imagen: solo data:image jpeg/png/webp, nada que ejecute o cargue de fuera', () => {
    expect(parseChatBg(JSON.stringify({ kind: 'gallery', color: 'gris', gallery: 'aurora' }))).toEqual({ kind: 'gallery', color: 'gris', gallery: 'aurora' });
    expect(parseChatBg(JSON.stringify({ kind: 'gallery', color: 'gris', gallery: '../x' }))).toEqual({ kind: 'gallery', color: 'gris' });
    expect(parseChatBg(JSON.stringify({ kind: 'image', color: 'gris', image: 'https://malo.test/x.png' }))).toEqual({ kind: 'image', color: 'gris' });
    expect(parseChatBg(JSON.stringify({ kind: 'image', color: 'gris', image: 'data:image/svg+xml;base64,AAAA' }))).toEqual({ kind: 'image', color: 'gris' });
    expect(parseChatBg(JSON.stringify({ kind: 'image', color: 'gris', image: 'data:image/jpeg;base64,AAAA"); background:url(x' }))).toEqual({ kind: 'image', color: 'gris' });
    expect(parseChatBg(JSON.stringify({ kind: 'image', color: 'gris', image: 'data:image/png;base64,AAAA' })).image).toBe('data:image/png;base64,AAAA');
  });

  it('en Apariencia: la galería se elige y se recuerda, y «Mi imagen» guarda la imagen reducida y se puede quitar', async () => {
    mockApi(authed(ME_ADMIN));
    renderApp('/settings/appearance');
    const fondo = await screen.findByRole('radiogroup', { name: 'Fondo del chat' });
    await userEvent.click(within(fondo).getByRole('radio', { name: /Galería/ }));
    const galeria = screen.getByRole('radiogroup', { name: 'Fondo de la galería' });
    expect(galeria.querySelectorAll('[role=radio]')).toHaveLength(6);
    await userEvent.click(within(galeria).getByRole('radio', { name: /Ondas/ }));
    expect(screen.getByRole('img', { name: 'Vista previa del chat' })).toHaveClass('chat-bg-g-waves');
    expect(JSON.parse(window.localStorage.getItem(chatBgKey('u1', 'o1')) ?? '{}')).toMatchObject({ kind: 'gallery', gallery: 'waves' });

    await userEvent.click(within(fondo).getByRole('radio', { name: /Mi imagen/ }));
    expect(within(fondo).getByRole('radio', { name: /Mi imagen/ })).toHaveAttribute('aria-checked', 'true');
    toBg.mockResolvedValueOnce('data:image/jpeg;base64,AAAA');
    await userEvent.upload(screen.getByLabelText('Elegir una imagen de fondo'), new File(['x'], 'foto.jpg', { type: 'image/jpeg' }));
    await screen.findByRole('button', { name: 'Quitar imagen' });
    expect(String(screen.getByRole('img', { name: 'Vista previa del chat' }).style.backgroundImage)).toContain('data:image/jpeg;base64,AAAA');
    expect(JSON.parse(window.localStorage.getItem(chatBgKey('u1', 'o1')) ?? '{}')).toMatchObject({ kind: 'image', image: 'data:image/jpeg;base64,AAAA' });
    toBg.mockRejectedValueOnce(new Error('La imagen debe ser JPEG, PNG o WebP.'));
    await userEvent.upload(screen.getByLabelText('Elegir una imagen de fondo'), new File(['x'], 'doc.gif', { type: 'image/gif' }), { applyAccept: false });
    expect(await screen.findByText('La imagen debe ser JPEG, PNG o WebP.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar imagen' }));
    expect(screen.queryByRole('button', { name: 'Quitar imagen' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(chatBgKey('u1', 'o1')) ?? '{}')).toMatchObject({ kind: 'default' });
  });

  it('la imagen propia rechaza lo que no es JPEG, PNG o WebP y lo mayor de 8 MB, antes de leerla', async () => {
    const real = await vi.importActual<typeof import('../src/ui/chatBackgroundImage')>('../src/ui/chatBackgroundImage');
    await expect(real.fileToChatBackground(new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toThrow('JPEG, PNG o WebP');
    const big = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    await expect(real.fileToChatBackground(big)).rejects.toThrow('8 MB');
  });
});
