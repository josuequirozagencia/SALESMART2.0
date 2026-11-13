import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus, ChatMessage, Conversation } from '../src/lib/types';
import { authed, err, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', status: 'pending', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: true, take: false, close: true, transfer: false, share: false }, sla: null, ...over,
});
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿qué horario tienen?', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over });

const STATUS = (over: Partial<AgentStatus> = {}): AgentStatus => ({ agent: { id: 'a1', name: 'Sofía', suggestions_enabled: false }, state: 'active', reason: null, can_control: true, ...over });

function server(w: { status: AgentStatus | 'error'; posts: string[]; messages?: ChatMessage[]; conv?: Conversation }) {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [w.conv ?? conv()], next_cursor: null, counts: { working: 0, pending: 1, closed: 0, unread: 0 } } }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: w.conv ?? conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: w.messages ?? [msg()], next_cursor: null } }),
    'GET /conversations/c1/ai': () => (w.status === 'error' ? err(404, 'NOT_FOUND', 'x') : { body: w.status }),
  };
  for (const a of ['pause', 'resume'] as const) {
    routes[`POST /conversations/c1/ai/${a}`] = () => {
      w.posts.push(a);
      w.status = a === 'pause' ? STATUS({ state: 'paused', reason: 'manual' }) : STATUS();
      return { body: w.status };
    };
  }
  return routes;
}

/** La barra amarilla sobre el chat ya no existe (v13 S2.1): el estado del agente y sus botones viven en la ficha del contacto, que se abre con «Datos del contacto». */
async function renderChat(): Promise<void> {
  renderApp('/inbox/c1');
  await userEvent.click(await screen.findByRole('button', { name: 'Datos del contacto' }));
}

describe('Inbox · agente de IA en la conversación', () => {
  it('con el agente atendiendo avisa quién es y deja «Tomar control»; al pulsarlo lo pausa y ofrece reanudarlo', async () => {
    const w = { status: STATUS(), posts: [] as string[] };
    mockApi(server(w));
    await renderChat();
    const banner = await screen.findByRole('status', { name: 'Agente de IA' });
    expect(banner).toHaveTextContent('Agente de IA atendiendo');
    expect(screen.getByRole('switch', { name: 'Agente de IA' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Tomar control' }));
    await waitFor(() => expect(w.posts).toEqual(['pause']));
    expect(await screen.findByRole('button', { name: 'Reanudar agente' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Agente de IA' })).toHaveTextContent('Pausaste al agente en esta conversación.');
    await userEvent.click(screen.getByRole('button', { name: 'Reanudar agente' }));
    await waitFor(() => expect(w.posts).toEqual(['pause', 'resume']));
    expect(await screen.findByRole('button', { name: 'Tomar control' })).toBeInTheDocument();
  });

  it.each([
    ['requested', 'El cliente pidió hablar con una persona.'],
    ['no_credits', 'la empresa se quedó sin créditos de IA'],
    ['no_support', 'no encontró en sus documentos'],
    ['ai_error', 'El servicio de IA no estuvo disponible.'],
    ['unsupported_media', 'algo que el agente no puede leer'],
    ['media_blocked', 'no pudo leer la imagen o el audio del cliente'],
    ['daily_limit', 'límite diario de imágenes o audios'],
    ['audio_too_long', 'audio demasiado largo'],
  ])('cuando el agente pasó la conversación a una persona (%s) dice por qué', async (reason, text) => {
    mockApi(server({ status: STATUS({ state: reason === 'no_credits' ? 'paused' : 'handed_off', reason }), posts: [] }));
    await renderChat();
    const banner = await screen.findByRole('status', { name: 'Agente de IA' });
    expect(banner).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Reanudar agente' })).toBeInTheDocument();
  });

  it.each([
    ['human_message', 'paused', 'Pausado: una persona intervino. Puedes reanudarlo.'],
    ['human_took', 'paused', 'Pausado: una persona intervino. Puedes reanudarlo.'],
    ['empty_reply', 'handed_off', 'El agente no pudo responder. Revisa esta conversación.'],
  ] as const)('texto aprobado para %s', async (reason, state, text) => {
    mockApi(server({ status: STATUS({ state, reason }), posts: [] }));
    await renderChat();
    expect(await screen.findByRole('status', { name: 'Agente de IA' })).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Reanudar agente' })).toBeInTheDocument();
  });

  it('sin créditos disponibles, «Reanudar agente» queda desactivado y dice por qué', async () => {
    mockApi(server({ status: STATUS({ state: 'paused', reason: 'no_credits', resume_blocked: 'no_credits' }), posts: [] }));
    await renderChat();
    const banner = await screen.findByRole('status', { name: 'Agente de IA' });
    expect(banner).toHaveTextContent('la empresa no tiene créditos de IA disponibles');
    expect(screen.getByRole('button', { name: 'Reanudar agente' })).toBeDisabled();
  });

  it('con el agente activo fuera del horario dice que espera el horario de atención y deja «Tomar control»', async () => {
    mockApi(server({ status: STATUS({ outcome: 'out_of_hours' }), posts: [] }));
    await renderChat();
    expect(await screen.findByRole('status', { name: 'Agente de IA' })).toHaveTextContent('El agente espera el horario de atención.');
    expect(screen.getByRole('button', { name: 'Tomar control' })).toBeInTheDocument();
  });

  it('no se muestra si la conexión no tiene agente, si no ha intervenido o si la conversación está finalizada', async () => {
    mockApi(server({ status: STATUS({ agent: null, state: 'idle', can_control: false }), posts: [] }));
    await renderChat();
    await screen.findAllByRole('heading', { name: 'Ana Torres' });
    expect(screen.queryByRole('status', { name: 'Agente de IA' })).not.toBeInTheDocument();
  });

  it('si la consulta del agente falla, la conversación se ve igual sin el aviso', async () => {
    mockApi(server({ status: 'error', posts: [] }));
    await renderChat();
    await screen.findAllByRole('heading', { name: 'Ana Torres' });
    expect(screen.queryByRole('status', { name: 'Agente de IA' })).not.toBeInTheDocument();
  });

  it('sin permiso de control muestra el aviso pero no los botones', async () => {
    mockApi(server({ status: STATUS({ can_control: false }), posts: [] }));
    await renderChat();
    await screen.findByRole('status', { name: 'Agente de IA' });
    expect(screen.queryByRole('button', { name: 'Tomar control' })).not.toBeInTheDocument();
  });

  it('los mensajes del agente llevan la etiqueta «Agente de IA» y no el nombre de una persona', async () => {
    mockApi(server({ status: STATUS(), posts: [], messages: [msg(), msg({ id: 'm2', direction: 'out', sender_type: 'ai', text: 'Abrimos de 9 a 18', status: 'sent', sent_at: ago(5 * MIN) })] }));
    await renderChat();
    expect(await screen.findByText('Abrimos de 9 a 18')).toBeInTheDocument();
    expect(screen.getAllByText('Agente de IA').length).toBeGreaterThan(0);
  });

  it('v13 S2.1: sin barra sobre el chat; el interruptor queda apagado y dice por qué («Agente en pausa: una persona intervino»)', async () => {
    mockApi(server({ status: STATUS({ state: 'paused', reason: 'human_message' }), posts: [] }));
    renderApp('/inbox/c1');
    const sw = await screen.findByRole('switch', { name: 'Agente de IA' });
    expect(sw).not.toBeChecked();
    expect(sw).toHaveAttribute('title', expect.stringContaining('Agente en pausa: una persona intervino'));
    expect(sw).toHaveTextContent('Agente en pausa: una persona intervino'); // para quien usa lector de pantalla (texto solo visual para ellos)
    // nada de la barra: ni el aviso ni sus botones sobre el chat (el panel del contacto está cerrado)
    expect(screen.queryByRole('status', { name: 'Agente de IA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reanudar agente' })).not.toBeInTheDocument();
  });

  it('v13 S2.1: atendiendo, el interruptor está encendido y pausarlo desde la cabecera manda la pausa', async () => {
    const w = { status: STATUS(), posts: [] as string[] };
    mockApi(server(w));
    renderApp('/inbox/c1');
    const sw = await screen.findByRole('switch', { name: 'Agente de IA' });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    await waitFor(() => expect(w.posts).toEqual(['pause']));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Agente de IA' })).not.toBeChecked());
    expect(screen.getByRole('switch', { name: 'Agente de IA' })).toHaveAttribute('title', expect.stringContaining('Agente en pausa: lo pausaron en esta conversación'));
  });
});
