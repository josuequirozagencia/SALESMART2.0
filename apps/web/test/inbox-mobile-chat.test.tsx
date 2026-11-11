import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDrafts, readDraft } from '../src/features/inbox/draftStore';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADVISOR, err, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

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
  clearDrafts();
});
afterEach(() => vi.unstubAllGlobals());

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation => ({
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
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true },
  sla: null,
  ...over,
});
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿tienen cita mañana?', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over });
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };

function server(c: Conversation = conv(), extra: Record<string, Handler> = {}): { routes: Record<string, Handler>; posts: Array<{ path: string; body: unknown }> } {
  const posts: Array<{ path: string; body: unknown }> = [];
  return {
    posts,
    routes: {
      ...authed(ME_ADVISOR),
      'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
      'GET /conversations/options': () => ({ body: OPTIONS }),
      'GET /conversations/c1': () => ({ body: c }),
      'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
      'POST /conversations/c1/read': () => ({ body: c }),
      'POST /conversations/c1/attachments': () => ({ status: 201, body: { id: 'a1', kind: 'image', mime_type: 'image/jpeg', filename: 'IMG_1.jpg', size_bytes: 1, scan_status: 'skipped', state: 'ready' } }),
      'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
      'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
      'GET /contacts/k1': () => err(404, 'NOT_FOUND'),
      'POST /conversations/c1/messages': (call: Call) => {
        posts.push({ path: '/conversations/c1/messages', body: call.body });
        return { status: 201, body: msg({ id: 'new', direction: 'out', sender_type: 'human', text: (call.body as { text: string }).text, status: 'sent' }) };
      },
      'POST /conversations/c1/notes': (call: Call) => {
        posts.push({ path: '/conversations/c1/notes', body: call.body });
        return { status: 201, body: msg({ id: 'nota', is_note: true, kind: 'note', text: (call.body as { text: string }).text, status: 'internal' }) };
      },
      ...extra,
    },
  };
}

const AI = (over: Record<string, unknown> = {}) => ({ agent: { id: 'a1', name: 'MAR_IA' }, state: 'paused', reason: 'human_message', can_control: true, ...over });
const qrChannel = { id: 'ch2', name: 'Chip de ventas', state: 'active', kind: 'qr', session: 'open' } as unknown as Conversation['channel'];

describe('Chat móvil · cabecera y panel (v10)', () => {
  it('cabecera: atrás, el bloque avatar+nombre, el ⋮; sin llamada ni «en línea», sin banner del agente y con el interruptor de IA deshabilitado si no hay agente', async () => {
    stubWidth(390);
    mockApi(server(conv(), { 'GET /conversations/c1/ai': () => ({ body: AI({ agent: null, state: 'idle', reason: null }) }) }).routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    expect(chat.getByRole('button', { name: 'Ver los datos de Ana Torres' })).toHaveTextContent('Ana Torres');
    expect(chat.getByText(/\+593984217730 · Barbería WhatsApp · Ventas/)).toBeInTheDocument();
    expect(chat.getByRole('link', { name: 'Volver a las conversaciones' })).toHaveAttribute('href', '/inbox');
    expect(chat.getByRole('button', { name: 'Más acciones' })).toBeInTheDocument();
    const sw = await chat.findByRole('switch', { name: 'Agente de IA' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('title', 'Sin agente en esta conversación');
    expect(chat.queryByRole('button', { name: /llam/i })).not.toBeInTheDocument();
    expect(chat.queryByText(/en línea/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).not.toBeInTheDocument();
  });

  it('el nombre de la cabecera y el ⋮ abren el MISMO panel de contacto; la X y Esc lo cierran y el foco vuelve a quien lo abrió', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    for (const opener of ['Ver los datos de Ana Torres', 'Más acciones']) {
      await userEvent.click(chat.getByRole('button', { name: opener }));
      const dlg = within(await screen.findByRole('dialog', { name: 'Datos del contacto' }));
      expect(screen.queryByRole('dialog', { name: 'Acciones de la conversación' })).not.toBeInTheDocument();
      for (const name of ['Transferir o compartir', 'Mensajes programados', 'Finalizar la conversación']) expect(dlg.getByRole('button', { name })).toBeInTheDocument();
      await userEvent.click(dlg.getByRole('button', { name: 'Cerrar los datos del contacto' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Datos del contacto' })).not.toBeInTheDocument());
      expect(chat.getByRole('button', { name: opener })).toHaveFocus();
    }
    await userEvent.click(chat.getByRole('button', { name: 'Más acciones' }));
    await screen.findByRole('dialog', { name: 'Datos del contacto' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Datos del contacto' })).not.toBeInTheDocument());
  });

  it('«Ver contacto» ya no es un ítem aparte: la hoja «Acciones de la conversación» no existe', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    await screen.findByRole('dialog', { name: 'Datos del contacto' });
    expect(screen.queryByRole('button', { name: 'Ver contacto' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Acciones de la conversación' })).not.toBeInTheDocument();
  });

  it('con Aceptar disponible aparece en el panel; «Finalizar» pide confirmación y «Transferir» no aparece sin permiso', async () => {
    stubWidth(390);
    const c = conv({ status: 'pending', can: { reply: false, note: true, accept: true, take: false, close: true, transfer: false, share: false } });
    mockApi(server(c).routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Datos del contacto' }));
    expect(dlg.getByRole('button', { name: 'Aceptar' })).toBeInTheDocument();
    expect(dlg.queryByRole('button', { name: 'Transferir o compartir' })).not.toBeInTheDocument();
    await userEvent.click(dlg.getByRole('button', { name: 'Finalizar la conversación' }));
    expect(dlg.getByRole('alertdialog', { name: 'Finalizar la conversación' })).toBeInTheDocument();
    await userEvent.click(dlg.getByRole('button', { name: 'No' }));
    expect(dlg.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('el canal QR se escribe «QR» a secas en la cabecera (y no dice «no oficial»)', async () => {
    stubWidth(390);
    mockApi(server(conv({ channel: qrChannel })).routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    expect(chat.getByText('QR')).toBeInTheDocument();
    expect(screen.queryByText(/no oficial/)).not.toBeInTheDocument();
  });

  it('agente PAUSADO: la cabecera trae el interruptor de IA apagado, no hay banner amarillo sobre el chat y el texto de pausa vive en el panel', async () => {
    stubWidth(390);
    const w = server(conv(), { 'GET /conversations/c1/ai': () => ({ body: AI() }) });
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    expect(await chat.findByRole('switch', { name: 'Agente de IA' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('status', { name: 'Agente de IA' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Pausado: una persona intervino/)).not.toBeInTheDocument();
    await userEvent.click(chat.getByRole('button', { name: 'Más acciones' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Datos del contacto' }));
    expect(await dlg.findByRole('status', { name: 'Agente de IA' })).toHaveTextContent('Pausado: una persona intervino. Puedes reanudarlo.');
    expect(dlg.getByRole('button', { name: 'Reanudar agente' })).toBeInTheDocument();
  });

  it('el interruptor de IA de la cabecera reanuda al agente al encenderlo y lo pausa al apagarlo', async () => {
    stubWidth(390);
    const calls: string[] = [];
    let state = AI();
    const w = server(conv(), { 'GET /conversations/c1/ai': () => ({ body: state }), 'POST /conversations/c1/ai/resume': () => { calls.push('resume'); state = AI({ state: 'active', reason: null }); return { body: state }; } });
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    await userEvent.click(await chat.findByRole('switch', { name: 'Agente de IA' }));
    await waitFor(() => expect(calls).toEqual(['resume']));
    await waitFor(() => expect(chat.getByRole('switch', { name: 'Agente de IA' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('apagar el interruptor de IA pausa al agente (POST pause) y queda apagado', async () => {
    stubWidth(390);
    const calls: string[] = [];
    let state = AI({ state: 'active', reason: null });
    const w = server(conv(), { 'GET /conversations/c1/ai': () => ({ body: state }), 'POST /conversations/c1/ai/pause': () => { calls.push('pause'); state = AI({ reason: 'manual' }); return { body: state }; } });
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    const sw = await chat.findByRole('switch', { name: 'Agente de IA' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    await waitFor(() => expect(calls).toEqual(['pause']));
    await waitFor(() => expect(chat.getByRole('switch', { name: 'Agente de IA' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('sin créditos de IA el interruptor apagado no se puede encender y dice por qué', async () => {
    stubWidth(390);
    mockApi(server(conv(), { 'GET /conversations/c1/ai': () => ({ body: AI({ reason: 'no_credits', resume_blocked: 'no_credits' }) }) }).routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    const sw = await chat.findByRole('switch', { name: 'Agente de IA' });
    expect(sw).toBeDisabled();
    expect(sw.getAttribute('title')).toMatch(/no tiene créditos de IA/);
  });

  it('agente ACTIVO: el interruptor de la cabecera está encendido y el panel dice quién atiende, con «Tomar control»', async () => {
    stubWidth(390);
    mockApi(server(conv(), { 'GET /conversations/c1/ai': () => ({ body: AI({ state: 'active', reason: null }) }) }).routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    await userEvent.click(chat.getByRole('button', { name: 'Más acciones' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Datos del contacto' }));
    expect(await dlg.findByRole('status', { name: 'Agente de IA' })).toHaveTextContent('Agente de IA atendiendo · MAR_IA');
    expect(dlg.getByRole('button', { name: 'Tomar control' })).toBeInTheDocument();
    expect(chat.getByRole('switch', { name: 'Agente de IA' })).toHaveAttribute('aria-checked', 'true');
  });

  it('«Destacar» está en el panel: pone la estrella (PUT) y la tarjeta pasa a «Quitar de destacadas» (DELETE)', async () => {
    stubWidth(390);
    const calls: string[] = [];
    let fav = false;
    const w = server(conv(), {
      'GET /conversations/c1': () => ({ body: conv({ favorite: fav }) }),
      'PUT /conversations/c1/favorite': () => { calls.push('PUT'); fav = true; return { body: conv({ favorite: true }) }; },
      'DELETE /conversations/c1/favorite': () => { calls.push('DELETE'); fav = false; return { body: conv({ favorite: false }) }; },
    });
    mockApi(w.routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Datos del contacto' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Destacar' }));
    await waitFor(() => expect(calls).toEqual(['PUT']));
    await userEvent.click(await dlg.findByRole('button', { name: 'Quitar de destacadas' }));
    await waitFor(() => expect(calls).toEqual(['PUT', 'DELETE']));
  });

  it('la cabecera móvil ya no lleva la fila de estado cuando todo va bien; el estado y el cronómetro están en el panel', async () => {
    stubWidth(390);
    const c = conv({ sla: { kind: 'followup', state: 'ok', started_at: ago(MIN), due_at: new Date(Date.now() + 30 * MIN).toISOString(), response_seconds: null } });
    mockApi(server(c).routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    await chat.findByRole('button', { name: 'Ver los datos de Ana Torres' });
    expect(chat.queryByText('Trabajando')).not.toBeInTheDocument();
    expect(chat.queryByText(/Responder en/)).not.toBeInTheDocument();
    expect(chat.queryByText(/Puedes escribir libremente/)).not.toBeInTheDocument();
    await userEvent.click(chat.getByRole('button', { name: 'Más acciones' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Datos del contacto' }));
    expect(dlg.getByText('Trabajando')).toBeInTheDocument();
    expect(dlg.getByText(/Responder en/)).toBeInTheDocument();
  });

  it('un cronómetro VENCIDO sí sigue a la vista en la cabecera móvil (pide acción)', async () => {
    stubWidth(390);
    const c = conv({ sla: { kind: 'followup', state: 'late', started_at: ago(2 * 60 * MIN), due_at: ago(30 * MIN), response_seconds: null } });
    mockApi(server(c).routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    expect(await chat.findByText(/Vencida hace/)).toBeInTheDocument();
  });

  it('un autor cuyo nombre es un correo se muestra como «Asesor»; el correo no aparece en ningún lado de la bandeja', async () => {
    stubWidth(390);
    const mail = 'josuequirozagencia@gmail.com';
    mockApi(server(conv(), { 'GET /conversations/c1/messages': () => ({ body: { items: [msg(), msg({ id: 'o1', direction: 'out', sender_type: 'human', author: { id: 'u9', name: mail }, text: 'Respuesta mía', status: 'sent' })], next_cursor: null } }) }).routes);
    renderApp('/inbox/c1');
    const log = within(await screen.findByRole('log', { name: 'Mensajes' }));
    expect(await log.findByText('Respuesta mía')).toBeInTheDocument();
    expect(log.getByText('Asesor')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(mail);
  });

  it('un mensaje escrito desde el teléfono lleva el icono de teléfono como avatar (no «?») y la etiqueta «Desde el teléfono»', async () => {
    stubWidth(390);
    mockApi(server(conv(), { 'GET /conversations/c1/messages': () => ({ body: { items: [msg(), msg({ id: 'd1', direction: 'out', sender_type: 'human', author: null, text: 'Te escribo desde el celular', status: 'sent', extra: { origin: 'device' } })], next_cursor: null } }) }).routes);
    renderApp('/inbox/c1');
    const log = within(await screen.findByRole('log', { name: 'Mensajes' }));
    expect(await log.findByText('Te escribo desde el celular')).toBeInTheDocument();
    expect(log.getByText(/Desde el teléfono/)).toBeInTheDocument();
    expect(document.querySelector('span[title="Desde el teléfono"] svg')).not.toBeNull();
    expect(log.queryByText('?')).not.toBeInTheDocument();
  });

  it('atrás: desde la lista vuelve a la lista; con un enlace directo (sin historia) va a /inbox', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('link', { name: 'Ana Torres' }));
    expect(await screen.findByRole('region', { name: 'Conversación con Ana Torres' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ana Torres' })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('link', { name: 'Volver a las conversaciones' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ana Torres' })).not.toHaveAttribute('aria-current'));
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('atrás con un enlace directo a la conversación lleva a la lista', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('link', { name: 'Volver a las conversaciones' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ana Torres' })).not.toHaveAttribute('aria-current'));
  });
});

describe('Chat móvil · redactor', () => {
  it('Enter da salto de línea y no envía; el botón alterna entre micrófono (vacío) y enviar (con texto)', async () => {
    stubWidth(390);
    const w = server();
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
    await userEvent.type(box, 'hola{Enter}segunda línea');
    expect(box).toHaveValue('hola\nsegunda línea');
    expect(w.posts).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Grabar nota de voz' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'hola\nsegunda línea' } }]));
    expect(box).toHaveValue('');
    expect(await screen.findByRole('button', { name: 'Grabar nota de voz' })).toBeInTheDocument();
  });

  it('la hoja «+» ofrece la cámara: el campo abre la cámara trasera y la foto tomada se sube y queda adjunta', async () => {
    stubWidth(390);
    const w = server();
    mockApi(w.routes);
    renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Mensaje' });
    const cam = screen.getByLabelText('Tomar foto o video con la cámara') as HTMLInputElement;
    expect(cam).toHaveAttribute('capture', 'environment');
    expect(cam.accept).toBe('image/*,video/*');
    await userEvent.upload(cam, new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText(/📎 Imagen/)).toBeInTheDocument();
  });

  it('«+» abre la hoja con adjuntar, plantillas, respuestas rápidas, programar y nota interna; la nota cambia el redactor y se puede dejar', async () => {
    stubWidth(390);
    const w = server();
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    const sheet = await screen.findByRole('dialog', { name: 'Más opciones del mensaje' });
    for (const name of [/^Cámara/, 'Fotos y videos', 'Documento o archivo', 'Plantillas', 'Respuestas rápidas', /Programar mensaje/, 'Escribir una nota interna']) expect(within(sheet).getByRole('button', { name })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Programar mensaje/ })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Escribir una nota interna' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Más opciones del mensaje' })).not.toBeInTheDocument());
    expect(screen.getByText('Nota interna · solo la ve tu equipo')).toBeInTheDocument();
    const note = screen.getByRole('textbox', { name: 'Nota interna' });
    expect(note).toBe(box);
    await userEvent.type(note, 'recordar llamar');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nota' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/notes', body: { text: 'recordar llamar' } }]));
    await userEvent.click(screen.getByRole('button', { name: 'Volver a responder' }));
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toBeInTheDocument();
  });

  it('el borrador se conserva al volver a la lista y reabrir; se borra al enviar; otra conversación no lo hereda', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('link', { name: 'Ana Torres' }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'a medio escribir');
    expect(readDraft('c1').text).toBe('a medio escribir');
    await userEvent.click(screen.getByRole('link', { name: 'Volver a las conversaciones' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Mensaje' })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('link', { name: 'Ana Torres' }));
    expect(await screen.findByRole('textbox', { name: 'Mensaje' })).toHaveValue('a medio escribir');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(readDraft('c1').text).toBe(''));
    expect(readDraft('otra').text).toBe('');
  });
});

describe('Chat móvil · distribución', () => {
  it('es una pantalla completa fija (sin la tarjeta del escritorio) y con el hilo como único desplazamiento', async () => {
    stubWidth(390);
    mockApi(server().routes);
    const { container } = renderApp('/inbox/c1');
    await screen.findByRole('region', { name: 'Conversación con Ana Torres' });
    const root = container.querySelector('.chat-screen');
    expect(root).not.toBeNull();
    expect(root).toHaveClass('fixed');
    const log = screen.getByRole('log', { name: 'Mensajes' });
    expect(log).toHaveClass('overflow-y-auto', 'overscroll-contain');
  });

  it('el escritorio no usa la pantalla completa y Enter sigue enviando', async () => {
    stubWidth(1440);
    const w = server();
    mockApi(w.routes);
    const { container } = renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(container.querySelector('.chat-screen')).toBeNull();
    await userEvent.type(box, 'hola{Enter}');
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'hola' } }]));
  });
});
