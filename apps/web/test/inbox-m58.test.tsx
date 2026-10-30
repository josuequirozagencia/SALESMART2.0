import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Contact, ContactTag, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

// M5.8 — Completar la bandeja: etiquetas en el chat, emojis, reacciones, íconos del redactor, notas de voz y la columna de datos del contacto.
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const SYSTEM: ContactTag = { id: 't-lead', name: 'Lead', color: '#6a44f2', system_key: 'lead', is_system: true };
const VIP: ContactTag = { id: 't-vip', name: 'VIP', color: '#d97706', system_key: null, is_system: false };
const FRIO: ContactTag = { id: 't-frio', name: 'Frío', color: '#2563eb', system_key: null, is_system: false };

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [SYSTEM, VIP],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null, ...over,
});
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿tienen cita mañana?', media: null, extra: null, reaction: null, my_reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over,
});
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [SYSTEM] };
const CONTACT: Contact = {
  id: 'k1', name: 'Ana Torres', email: 'ana@correo.test', phones: [{ e164: '+593984217730', primary: true }], owner: { id: 'u2', name: 'Luis Navas' }, source: 'meta_ctwa', consent: 'granted', consent_updated_at: null,
  custom_fields: { ciudad: 'Guayaquil' }, tags: [SYSTEM, VIP], companies: [{ id: 'co1', name: 'Barbería Norte' }], attribution: null, created_at: ago(9 * HOUR), updated_at: ago(HOUR),
};

interface World {
  conv: Conversation;
  messages: ChatMessage[];
  tags: ContactTag[];
  manage: boolean;
  patches: Array<{ path: string; body: unknown }>;
  creates: unknown[];
  reactions: Array<{ path: string; body: unknown }>;
  appointments: unknown[];
  sales: unknown[];
}
const world = (over: Partial<World> = {}): World => ({ conv: conv(), messages: [msg()], tags: [SYSTEM, VIP, FRIO], manage: true, patches: [], creates: [], reactions: [], appointments: [], sales: [], ...over });

function server(w: World, me = ME_ADVISOR): Record<string, Handler> {
  return {
    ...authed(me),
    'GET /conversations': () => ({ body: { items: [w.conv], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: w.conv }),
    'GET /conversations/c1/messages': () => ({ body: { items: w.messages, next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /tags': () => ({ body: { items: w.tags, access: { manage: w.manage } } }),
    'POST /tags': (call) => {
      w.creates.push(call.body);
      const b = call.body as { name: string; color: string };
      const t: ContactTag = { id: 't-new', name: b.name, color: b.color, system_key: null, is_system: false };
      w.tags = [...w.tags, t];
      return { status: 201, body: t };
    },
    'PATCH /contacts/k1': (call) => {
      w.patches.push({ path: '/contacts/k1', body: call.body });
      const ids = (call.body as { tag_ids: string[] }).tag_ids;
      w.conv = { ...w.conv, tags: [...w.conv.tags.filter((t) => t.is_system), ...w.tags.filter((t) => ids.includes(t.id))] };
      return { body: CONTACT };
    },
    'PUT /conversations/c1/messages/m1/reaction': (call) => {
      w.reactions.push({ path: '/conversations/c1/messages/m1/reaction', body: call.body });
      const emoji = (call.body as { emoji: string | null }).emoji;
      w.messages = w.messages.map((m) => (m.id === 'm1' ? { ...m, my_reaction: emoji } : m));
      return { body: { id: 'm1', my_reaction: emoji } };
    },
    'GET /contacts/k1': () => ({ body: CONTACT }),
    'GET /contacts/owners': () => ({ body: { items: [{ id: 'u2', name: 'Luis Navas' }] } }),
    'GET /custom-fields': () => ({ body: { items: [{ id: 'f1', entity: 'contact', name: 'Ciudad', key: 'ciudad', type: 'text', options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: ago(HOUR) }], access: { manage: false } } }),
    'GET /appointments': () => ({ body: { items: w.appointments, timezone: 'America/Guayaquil' } }),
    'GET /sales': () => ({ body: { items: w.sales, next_cursor: null } }),
  };
}

const open = async (w: World, me = ME_ADVISOR) => {
  mockApi(server(w, me));
  renderApp('/inbox/c1');
  await screen.findByRole('log', { name: 'Mensajes' });
};

describe('Inbox · etiquetas del contacto', () => {
  it('la cabecera muestra las etiquetas y «Etiquetas» abre el diálogo: las del sistema solo se ven; las personalizadas se marcan y desmarcan', async () => {
    const w = world();
    await open(w);
    expect((await screen.findAllByText('VIP')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Etiquetas del contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Etiquetas de Ana Torres' }));
    expect(await d.findByText('Lead')).toBeInTheDocument(); // del sistema: sin casilla
    expect(d.queryByRole('checkbox', { name: /Lead/ })).toBeNull();
    expect(await d.findByRole('checkbox', { name: /VIP/ })).toBeChecked();
    expect(d.getByRole('checkbox', { name: /Frío/ })).not.toBeChecked();
    await userEvent.click(d.getByRole('checkbox', { name: /Frío/ }));
    await waitFor(() => expect(w.patches.at(-1)).toEqual({ path: '/contacts/k1', body: { tag_ids: ['t-vip', 't-frio'] } }));
    await userEvent.click(d.getByRole('checkbox', { name: /VIP/ }));
    await waitFor(() => expect(w.patches.at(-1)!.body).toEqual({ tag_ids: ['t-frio'] }));
  });

  it('quien puede administrar etiquetas crea una nueva sin salir del chat y se la agrega al contacto', async () => {
    const w = world();
    await open(w, ME_ADMIN);
    await userEvent.click(await screen.findByRole('button', { name: 'Etiquetas del contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Etiquetas de Ana Torres' }));
    const form = within(await d.findByRole('form', { name: 'Crear etiqueta' }));
    await userEvent.type(form.getByLabelText('Nombre'), 'Cliente frecuente');
    await userEvent.click(form.getByRole('button', { name: 'Crear y agregar' }));
    await waitFor(() => expect(w.creates).toHaveLength(1));
    expect(w.creates[0]).toMatchObject({ name: 'Cliente frecuente' });
    await waitFor(() => expect(w.patches.at(-1)!.body).toEqual({ tag_ids: ['t-vip', 't-new'] }));
  });

  it('sin permiso para administrar etiquetas no aparece el formulario de crear: solo se eligen las existentes', async () => {
    const w = world({ manage: false });
    await open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Etiquetas del contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Etiquetas de Ana Torres' }));
    await d.findByRole('checkbox', { name: /VIP/ });
    expect(d.queryByRole('form', { name: 'Crear etiqueta' })).toBeNull();
  });
});

describe('Inbox · redactor: emojis, íconos y notas de voz', () => {
  it('adjuntar y grabar son botones de ícono con nombre accesible, sin texto visible', async () => {
    await open(world());
    const clip = await screen.findByRole('button', { name: 'Adjuntar archivo' });
    const mic = screen.getByRole('button', { name: 'Grabar nota de voz' });
    expect(clip).toHaveAttribute('title', 'Adjuntar archivo');
    expect(clip.textContent).toBe('');
    expect(mic.textContent).toBe('');
    expect(clip.className).toContain('size-11'); // área táctil de 44 px
  });

  it('el selector de emojis busca por nombre, inserta en el cursor, guarda recientes y se maneja con teclado', async () => {
    await open(world());
    const box = await screen.findByLabelText('Mensaje');
    await userEvent.type(box, 'Hola ');
    await userEvent.click(screen.getByRole('button', { name: 'Emojis' }));
    const picker = within(await screen.findByRole('dialog', { name: 'Selector de emojis' }));
    await userEvent.type(picker.getByRole('searchbox', { name: 'Buscar emoji' }), 'fuego');
    await userEvent.click(await picker.findByRole('gridcell', { name: 'fuego' }));
    expect(box).toHaveValue('Hola 🔥');
    expect(JSON.parse(localStorage.getItem('ss.emoji.recent') ?? '[]')).toEqual(['🔥']);
    // teclado: desde la búsqueda, ↓ baja a la cuadrícula; Enter elige; Esc cierra y devuelve el foco al mensaje
    await userEvent.clear(picker.getByRole('searchbox', { name: 'Buscar emoji' }));
    await userEvent.type(picker.getByRole('searchbox', { name: 'Buscar emoji' }), 'gracias{ArrowDown}');
    expect(picker.getAllByRole('gridcell')[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('Hola 🔥🙏');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Selector de emojis' })).toBeNull());
    expect(box).toHaveFocus();
  });

  it('una búsqueda sin resultados lo dice', async () => {
    await open(world());
    await userEvent.click(await screen.findByRole('button', { name: 'Emojis' }));
    const picker = within(await screen.findByRole('dialog', { name: 'Selector de emojis' }));
    await userEvent.type(picker.getByRole('searchbox', { name: 'Buscar emoji' }), 'zzzz');
    expect(await picker.findByText(/No hay emojis que coincidan/)).toBeInTheDocument();
  });

  describe('nota de voz', () => {
    const stubMic = (): { stopped: () => number } => {
      let stops = 0;
      const track = { stop: () => { stops += 1; } };
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) } });
      class FakeRecorder {
        static isTypeSupported = (): boolean => true;
        mimeType = 'audio/webm;codecs=opus';
        state: 'inactive' | 'recording' = 'inactive';
        ondataavailable: ((e: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start(): void { this.state = 'recording'; }
        stop(): void {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
          this.onstop?.();
        }
      }
      vi.stubGlobal('MediaRecorder', FakeRecorder);
      return { stopped: () => stops };
    };

    it('graba directo desde el redactor con el tiempo a la vista; cancelar libera el micrófono y no sube nada', async () => {
      const mic = stubMic();
      const w = world();
      mockApi({ ...server(w) });
      renderApp('/inbox/c1');
      await userEvent.click(await screen.findByRole('button', { name: 'Grabar nota de voz' }));
      expect(await screen.findByText(/Grabando 0:0\d/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Adjuntar archivo' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Cancelar la grabación' }));
      await waitFor(() => expect(screen.queryByText(/Grabando/)).toBeNull());
      expect(mic.stopped()).toBe(1);
    });

    it('al detener sube el audio a la conversación y queda adjunto listo para enviar', async () => {
      stubMic();
      const w = world();
      const uploads: number[] = [];
      mockApi({
        ...server(w),
        'POST /conversations/c1/attachments': (call) => {
          uploads.push((call.body as { raw_bytes: number }).raw_bytes);
          return { status: 201, body: { id: 'a9', kind: 'audio', mime_type: 'audio/webm', filename: 'grabacion.webm', size_bytes: 3, scan_status: 'skipped', state: 'ready' } };
        },
      });
      renderApp('/inbox/c1');
      await userEvent.click(await screen.findByRole('button', { name: 'Grabar nota de voz' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Detener y adjuntar la nota de voz' }));
      await waitFor(() => expect(uploads).toEqual([3]));
      expect(await screen.findByText(/grabacion\.webm/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enviar archivo' })).toBeEnabled();
    });
  });
});

describe('Inbox · reacciones', () => {
  it('reaccionar a un mensaje del cliente manda el emoji, lo muestra sobre la burbuja y se puede quitar', async () => {
    const w = world();
    await open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Reaccionar al mensaje' }));
    const menu = within(screen.getByRole('group', { name: 'Elige una reacción' }));
    await userEvent.click(menu.getByRole('button', { name: 'Reaccionar con 👍' }));
    await waitFor(() => expect(w.reactions.at(-1)).toEqual({ path: '/conversations/c1/messages/m1/reaction', body: { emoji: '👍' } }));
    expect(await screen.findByRole('img', { name: 'Tu reacción: 👍' })).toBeInTheDocument();
    // quitarla: el menú ofrece «Quitar mi reacción»
    await userEvent.click(screen.getByRole('button', { name: 'Reaccionar al mensaje' }));
    await userEvent.click(screen.getByRole('button', { name: 'Quitar mi reacción' }));
    await waitFor(() => expect(w.reactions.at(-1)!.body).toEqual({ emoji: null }));
    await waitFor(() => expect(screen.queryByRole('img', { name: /Tu reacción/ })).toBeNull());
  });

  it('no se ofrece en mensajes propios, con la ventana de 24 h cerrada, sin poder responder ni por GoHighLevel/QR', async () => {
    const own = msg({ id: 'm2', direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' }, text: 'Claro que sí', status: 'sent' });
    await open(world({ messages: [msg(), own] }));
    expect(await screen.findAllByRole('button', { name: 'Reaccionar al mensaje' })).toHaveLength(1); // solo el del cliente
    for (const c of [conv({ window: { open: false, expires_at: null } }), conv({ can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } }), conv({ channel: { id: 'ch1', name: 'QR', state: 'active', kind: 'qr', session: 'open' } }), conv({ channel: { id: 'ch1', name: 'GHL', state: 'active', kind: 'ghl' } })]) {
      cleanup();
      vi.unstubAllGlobals();
      resetWorld();
      mockApi(server(world({ conv: c })));
      renderApp('/inbox/c1');
      await screen.findByRole('log', { name: 'Mensajes' });
      await screen.findByText('Hola, ¿tienen cita mañana?');
      expect(screen.queryByRole('button', { name: 'Reaccionar al mensaje' })).toBeNull();
    }
  });

  it('si WhatsApp rechaza la reacción, se muestra el motivo', async () => {
    const w = world();
    mockApi({ ...server(w), 'PUT /conversations/c1/messages/m1/reaction': () => ({ status: 409, body: { error: { code: 'REACTION_REJECTED', message: 'WhatsApp no aceptó la reacción (el mensaje puede tener más de 30 días)', request_id: 'r', details: [] } } }) });
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Reaccionar al mensaje' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reaccionar con ❤️' }));
    expect(await screen.findByText(/WhatsApp no aceptó la reacción/)).toBeInTheDocument();
  });
});

describe('Inbox · columna de datos del contacto', () => {
  it('arranca oculta; se abre con el botón o pulsando el nombre y junta datos, campos, cita, ventas y accesos a oportunidades, notas y tareas', async () => {
    const w = world({
      appointments: [{ id: 'a1', contact: { id: 'k1', name: 'Ana Torres' }, conversation_id: 'c1', owner: { id: 'u2', name: 'Luis Navas' }, starts_at: new Date(Date.now() + 26 * HOUR).toISOString(), ends_at: new Date(Date.now() + 27 * HOUR).toISOString(), duration_minutes: 30, kind: 'Corte', notes: null, status: 'scheduled', cancel_reason: null, created_at: ago(HOUR), reminders: [], reminder_offsets: [], reminder_template: null, can: { edit: true, cancel: true, complete: true } }],
      sales: [{ id: 's1', contact: { id: 'k1', name: 'Ana Torres' }, conversation_id: 'c1', product: { id: 'p1', name: 'Corte y barba', kind: 'service' }, quantity: 1, amount: '25.00', currency: 'USD', paid: '10.00', balance: '15.00', collected: false, status: 'active', seller: null, note: null, created_at: ago(2 * HOUR), cancelled_at: null, cancel_reason: null, open_requests: 0, purchase: null }],
    });
    await open(w);
    expect(screen.queryByRole('complementary', { name: 'Datos del contacto' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Datos de Ana Torres' })); // pulsar el nombre
    const side = within(await screen.findByRole('complementary', { name: 'Datos del contacto' }));
    expect((await side.findAllByText('+593984217730')).length).toBeGreaterThan(0); // en el encabezado de la columna y en sus teléfonos
    expect(side.getByText('ana@correo.test')).toBeInTheDocument();
    expect(side.getAllByText('Luis Navas').length).toBeGreaterThan(0);
    expect(side.getByText('Con consentimiento')).toBeInTheDocument();
    expect(await side.findByText('Guayaquil')).toBeInTheDocument(); // campo personalizado
    expect(await side.findByText(/^· Corte$/)).toBeInTheDocument(); // próxima cita
    expect(await side.findByText('Corte y barba')).toBeInTheDocument(); // última venta
    expect(side.getByText(/Saldo/)).toBeInTheDocument();
    for (const name of ['Oportunidades', 'Notas', 'Tareas']) expect(side.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(side.getByRole('button', { name: 'Cerrar los datos del contacto' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Datos del contacto' })).toBeNull());
    // y vuelve con el botón de la cabecera
    await userEvent.click(screen.getByRole('button', { name: 'Datos del contacto' }));
    expect(await screen.findByRole('complementary', { name: 'Datos del contacto' })).toBeInTheDocument();
  });

  it('si la persona no tiene acceso a la agenda o a las ventas, esos bloques lo dicen en vez de romper', async () => {
    const w = world();
    mockApi({ ...server(w), 'GET /appointments': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'x', request_id: 'r', details: [] } } }), 'GET /sales': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'x', request_id: 'r', details: [] } } }) });
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Datos del contacto' }));
    const side = within(await screen.findByRole('complementary', { name: 'Datos del contacto' }));
    expect(await side.findByText('No tienes acceso a la agenda.')).toBeInTheDocument();
    expect(await side.findByText('No tienes acceso a las ventas.')).toBeInTheDocument();
  });
});
