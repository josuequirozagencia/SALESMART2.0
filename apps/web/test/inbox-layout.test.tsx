import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_MIN, CONTACT_RANGE, LIST_RANGE, resolveLayout } from '../src/features/inbox/inboxLayout';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { Drawer } from '../src/ui/Drawer';
import { layoutKey, parseLayout, readLayout } from '../src/ui/layoutStore';
import { ResizeHandle } from '../src/ui/ResizeHandle';
import { authed, ME_ADVISOR, err, mockApi, renderApp, resetWorld, type Handler } from './helpers';

/** `matchMedia` de mentira para un ancho dado (jsdom no lo trae). */
function stubWidth(width: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return { matches, media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('distribución de columnas (pura)', () => {
  const base = { listWidth: LIST_RANGE.def, contactWidth: CONTACT_RANGE.def, listOpen: true, contactOpen: true };

  it('a 1280 con la barra lateral expandida (≈1008 px) el contacto se pliega y el chat supera el 60 %', () => {
    const r = resolveLayout({ ...base, width: 1008 });
    expect(r.contactShown).toBe(false);
    expect(r.contactBlocked).toBe(true);
    expect(r.list).toBe(300);
    expect((1008 - r.list) / 1008).toBeGreaterThan(0.6);
  });

  it('con espacio (≈1172 px) caben los tres y el chat conserva al menos 520 px; los paneles no se superponen', () => {
    const r = resolveLayout({ ...base, width: 1172 });
    expect(r.contactShown).toBe(true);
    expect(r.list + r.contact + CHAT_MIN).toBeLessThanOrEqual(1172);
    expect(1172 - r.list - r.contact).toBeGreaterThanOrEqual(CHAT_MIN);
  });

  it('prioridad: primero se pliega el contacto; después la lista se estrecha hasta su mínimo y nunca menos', () => {
    expect(resolveLayout({ ...base, width: 900 }).contactShown).toBe(false);
    expect(resolveLayout({ ...base, width: 900 }).list).toBe(300);
    expect(resolveLayout({ ...base, contactOpen: false, width: 700 }).list).toBe(LIST_RANGE.min);
    expect(resolveLayout({ ...base, contactOpen: false, width: 400 }).list).toBe(LIST_RANGE.min);
  });

  it('los anchos guardados se acotan a sus rangos', () => {
    const r = resolveLayout({ ...base, listWidth: 900, contactWidth: 5, width: 3000 });
    expect(r.list).toBe(LIST_RANGE.max);
    expect(r.contact).toBe(CONTACT_RANGE.min);
  });

  it('lista plegada: ancho 0 y el contacto puede crecer; ancho aún desconocido (0): no se recorta nada', () => {
    const closed = resolveLayout({ ...base, listOpen: false, width: 1008 });
    expect(closed.list).toBe(0);
    expect(closed.listShown).toBe(false);
    expect(closed.contactShown).toBe(true);
    const unknown = resolveLayout({ ...base, width: 0 });
    expect(unknown.contactShown).toBe(true);
    expect(unknown.list).toBe(300);
  });

  it('el máximo de cada divisor deja siempre 520 px al chat', () => {
    const r = resolveLayout({ ...base, width: 1172 });
    expect(1172 - r.contact - r.listMax).toBeGreaterThanOrEqual(CHAT_MIN);
    expect(1172 - r.list - r.contactMax).toBeGreaterThanOrEqual(CHAT_MIN);
  });
});

describe('preferencias de distribución guardadas', () => {
  it('solo se leen números dentro de rango y booleanos; lo demás se ignora', () => {
    expect(parseLayout('{"listWidth":330,"contactWidth":280,"listOpen":false,"contactOpen":true}')).toEqual({ listWidth: 330, contactWidth: 280, listOpen: false, contactOpen: true });
    expect(parseLayout('{"listWidth":"ancho","contactWidth":-4,"listOpen":"sí","contactOpen":1}')).toEqual({});
    expect(parseLayout('{"listWidth":99999}')).toEqual({});
  });
});

describe('divisor (ResizeHandle)', () => {
  function Harness({ grows = 1 as 1 | -1 }) {
    const [value, setValue] = useState(300);
    const [log, setLog] = useState<string[]>([]);
    return (
      <div>
        <ResizeHandle
          label="Cambiar el ancho"
          value={value}
          min={260}
          max={420}
          grows={grows}
          onPreview={(px) => setLog((l) => [...l, `p${px}`])}
          onCommit={(px) => setValue(px)}
          onCollapse={() => setLog((l) => [...l, 'collapse'])}
          onReset={() => setValue(300)}
        />
        <output data-testid="v">{value}</output>
        <output data-testid="log">{log.join(',')}</output>
      </div>
    );
  }

  it('es un separador vertical enfocable con valores', () => {
    render(<Harness />);
    const s = screen.getByRole('separator', { name: 'Cambiar el ancho' });
    expect(s).toHaveAttribute('aria-orientation', 'vertical');
    expect(s).toHaveAttribute('aria-valuenow', '300');
    expect(s).toHaveAttribute('aria-valuemin', '260');
    expect(s).toHaveAttribute('aria-valuemax', '420');
    expect(s).toHaveAttribute('tabindex', '0');
  });

  it('flechas ±16, Mayús ±64, límites, Inicio pliega, Fin va al máximo y doble clic restaura', async () => {
    render(<Harness />);
    const s = screen.getByRole('separator');
    s.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('v')).toHaveTextContent('316');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByTestId('v')).toHaveTextContent('284');
    await userEvent.keyboard('{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}');
    expect(screen.getByTestId('v')).toHaveTextContent('260');
    await userEvent.keyboard('{Home}');
    expect(screen.getByTestId('log')).toHaveTextContent('collapse');
    await userEvent.keyboard('{End}');
    expect(screen.getByTestId('v')).toHaveTextContent('420');
    await userEvent.dblClick(s);
    expect(screen.getByTestId('v')).toHaveTextContent('300');
  });

  it('en el divisor de la columna derecha, la flecha izquierda la ensancha', async () => {
    render(<Harness grows={-1} />);
    screen.getByRole('separator').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('v')).toHaveTextContent('316');
  });

  it('arrastrar con el puntero avisa por cuadro y guarda solo al soltar; devuelve la selección de texto', async () => {
    render(<Harness />);
    const s = screen.getByRole('separator');
    const down = createEvent.pointerDown(s, { button: 0, clientX: 100, pointerId: 1 });
    Object.defineProperty(down, 'clientX', { value: 100 });
    fireEvent(s, down);
    expect(document.body.style.userSelect).toBe('none');
    const move = createEvent.pointerMove(s, { clientX: 140, pointerId: 1 });
    Object.defineProperty(move, 'clientX', { value: 140 });
    fireEvent(s, move);
    await waitFor(() => expect(screen.getByTestId('log')).toHaveTextContent('p340'));
    expect(screen.getByTestId('v')).toHaveTextContent('300');
    fireEvent(s, createEvent.pointerUp(s, { pointerId: 1 }));
    expect(screen.getByTestId('v')).toHaveTextContent('340');
    expect(document.body.style.userSelect).toBe('');
  });
});

describe('cajón (Drawer)', () => {
  it('foco adentro al abrir, atrapado con Tab, Esc cierra y el foco vuelve a quien lo abrió', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button onClick={() => setOpen(true)}>Abrir</button>
          {open ? (
            <Drawer label="Panel" onClose={() => setOpen(false)}>
              <button>Uno</button>
              <button>Dos</button>
            </Drawer>
          ) : null}
        </div>
      );
    }
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    const dlg = screen.getByRole('dialog', { name: 'Panel' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Uno' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Dos' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Uno' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Dos' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir' })).toHaveFocus();
  });
});

// ── Inbox completo ─────────────────────────────────────────────────────────────
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const CONV: Conversation = {
  id: 'c1',
  status: 'working',
  unread_count: 0,
  last_message_at: ago(5 * MIN),
  last_inbound_at: ago(60 * MIN),
  assigned_at: ago(120 * MIN),
  closed_at: null,
  created_at: ago(180 * MIN),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' },
  owner: { id: 'u2', name: 'Luis Navas' },
  participants: [],
  my_access: 'owner',
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
  tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola, ¿tienen cita mañana?', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * 60 * MIN).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false },
  sla: null,
};
const MSG: ChatMessage = { id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿tienen cita mañana?', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null };
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };
const routes = (): Record<string, Handler> => ({
  ...authed(ME_ADVISOR),
  'GET /conversations': () => ({ body: { items: [CONV], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
  'GET /conversations/options': () => ({ body: OPTIONS }),
  'GET /conversations/c1': () => ({ body: CONV }),
  'GET /conversations/c1/messages': () => ({ body: { items: [MSG], next_cursor: null } }),
  'POST /conversations/c1/read': () => ({ body: CONV }),
  'GET /contacts/k1': () => err(404, 'NOT_FOUND'),
});
const KEY = layoutKey(ME_ADVISOR.user.id, ME_ADVISOR.organization.id);

describe('Inbox de escritorio (≥ 1280 px)', () => {
  it('el contacto nace plegado; al abrirlo queda al lado (sin cajón) con dos divisores, se guarda y no se pierde el borrador', async () => {
    stubWidth(1440);
    mockApi(routes());
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.type(box, 'borrador a medias');
    expect(screen.queryByRole('complementary', { name: 'Datos del contacto' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Datos del contacto' }));
    expect(await screen.findByRole('complementary', { name: 'Datos del contacto' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Datos del contacto' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(readLayout(ME_ADVISOR.user.id, ME_ADVISOR.organization.id).contactOpen).toBe(true);
    // el hilo no se reinició: el mismo campo y el borrador intacto
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toBe(box);
    expect(box).toHaveValue('borrador a medias');
  });

  it('teclado en el divisor de la lista cambia el ancho y lo guarda por persona y empresa; Inicio pliega la lista y «Restaurar distribución» lo devuelve todo', async () => {
    stubWidth(1440);
    mockApi(routes());
    renderApp('/inbox/c1');
    const sep = await screen.findByRole('separator', { name: 'Cambiar el ancho de la lista de conversaciones' });
    expect(sep).toHaveAttribute('aria-valuenow', '300');
    sep.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(readLayout(ME_ADVISOR.user.id, ME_ADVISOR.organization.id).listWidth).toBe(316));
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toMatchObject({ listWidth: 316 });
    expect(window.localStorage.getItem(layoutKey('otra', 'empresa'))).toBeNull();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(screen.queryByRole('separator', { name: 'Cambiar el ancho de la lista de conversaciones' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Lista de conversaciones' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar distribución' }));
    expect(await screen.findByRole('separator', { name: 'Cambiar el ancho de la lista de conversaciones' })).toHaveAttribute('aria-valuenow', '300');
    expect(readLayout(ME_ADVISOR.user.id, ME_ADVISOR.organization.id)).toEqual({});
  });

  it('lo guardado se aplica al volver a abrir', async () => {
    stubWidth(1440);
    window.localStorage.setItem(KEY, JSON.stringify({ listWidth: 380, contactOpen: true, contactWidth: 330 }));
    mockApi(routes());
    renderApp('/inbox/c1');
    expect(await screen.findByRole('separator', { name: 'Cambiar el ancho de la lista de conversaciones' })).toHaveAttribute('aria-valuenow', '380');
    expect(await screen.findByRole('separator', { name: 'Cambiar el ancho de los datos del contacto' })).toHaveAttribute('aria-valuenow', '330');
  });
});

describe('Inbox de tablet (768–1279 px)', () => {
  it('lista y chat a la vez; el contacto es un cajón que se cierra con Esc y devuelve el foco; no hay divisores', async () => {
    stubWidth(1000);
    mockApi(routes());
    renderApp('/inbox/c1');
    expect(await screen.findByRole('region', { name: 'Conversaciones' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Conversación con Ana Torres' })).toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Datos del contacto' });
    await userEvent.click(open);
    expect(await screen.findByRole('dialog', { name: 'Datos del contacto' })).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Datos del contacto' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Datos del contacto' })).toHaveFocus();
    // lo del escritorio no se tocó
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
