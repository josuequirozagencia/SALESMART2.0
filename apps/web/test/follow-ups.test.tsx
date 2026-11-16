import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/features/agents/useAgents';
import type { FollowUps } from '../src/features/agents/useFollowUps';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-11-11T15:00:00.000Z';
const AGENT = {
  id: 'a1', name: 'Sofía', role: null, photo_url: null, cover: 'violet', active: true, model: 'gpt-4o-mini', channels: [], documents: 0, chunks: 0, created_at: AT,
  temperature: 0.3, max_tokens: 500, max_chars: 800, personality: 'Cálida', objective: '', extra_info: '', show_source: false, split_enabled: false, split_blocks: 2, transfer_enabled: true, transfer_queue_id: null, always_on: true,
  capture_fields: [], tasks_enabled: false, suggestions_enabled: false, read_images: false, transcribe_audio: false, document_ids: [], channel_ids: [], readiness: { instructions: true, documents: true, channel: true }, updated_at: AT,
} as Agent;
const OPTIONS = { models: ['gpt-4o-mini'], covers: ['violet'], limits: { max_agents: 20, max_photo_bytes: 1, max_chunks: 5000, max_capture_fields: 10 }, variables: [], channels: [], queues: [], capture_options: [], documents: [] };
const FU = (over: Partial<FollowUps> = {}): FollowUps => ({ scenario: 'stopped_replying', enabled: false, steps: [], variables: ['primer_nombre', 'nombre', 'mi_nombre'], automations: [{ id: 'au1', name: 'Bienvenida' }], summary: { sent: 0, skipped: 0, cancelled: 0, pending: 0, reasons: {} }, updated_at: null, ...over });

interface World { fu: FollowUps; puts: Call[]; fail?: () => ReturnType<Handler> }
function server(w: World): Record<string, Handler> {
  return {
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /agents': () => ({ body: { items: [AGENT], limits: { max_agents: 20 } } }),
    'GET /agents/options': () => ({ body: OPTIONS }),
    'GET /agents/a1': () => ({ body: AGENT }),
    'GET /agents/a1/follow-ups': () => ({ body: w.fu }),
    'PUT /agents/a1/follow-ups': (c) => {
      w.puts.push(c);
      if (w.fail) return w.fail();
      const b = c.body as { enabled: boolean; steps: Array<{ delay_minutes: number; mode: 'ai' | 'fixed_text' | 'none'; fixed_text?: string | null; start_automation_id?: string | null }> };
      w.fu = FU({ enabled: b.enabled, steps: b.steps.map((s, i) => ({ position: i + 1, delay_minutes: s.delay_minutes, mode: s.mode, fixed_text: s.fixed_text ?? null, start_automation_id: s.start_automation_id ?? null })), updated_at: new Date().toISOString() });
      return { body: w.fu };
    },
  };
}
const openTab = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Abrir el agente Sofía' }));
  const d = within(await screen.findByRole('dialog', { name: 'Agente Sofía' }));
  await userEvent.click(d.getByRole('tab', { name: 'Seguimiento' }));
  return d;
};

describe('Agente · pestaña «Seguimiento»', () => {
  it('sin pasos lo dice; agregar un paso de IA y guardar manda la secuencia en minutos', async () => {
    const w: World = { fu: FU(), puts: [] };
    mockApi(server(w));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findByText('Aún no hay pasos. Agrega el primero.')).toBeInTheDocument();
    await userEvent.click(d.getByRole('switch', { name: /Activar los seguimientos/ }));
    await userEvent.click(d.getByRole('button', { name: 'Agregar paso' }));
    await userEvent.click(d.getByRole('button', { name: 'Agregar paso' }));
    await userEvent.selectOptions(d.getAllByLabelText('Unidad')[1]!, 'days');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.puts[0]!.body).toEqual({ enabled: true, steps: [{ delay_minutes: 30, mode: 'ai', fixed_text: null, start_automation_id: null }, { delay_minutes: 1440, mode: 'ai', fixed_text: null, start_automation_id: null }] }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('un texto fijo es obligatorio y se valida antes de enviar; con texto sale recortado', async () => {
    const w: World = { fu: FU({ enabled: true }), puts: [] };
    mockApi(server(w));
    renderApp('/agents');
    const d = await openTab();
    await userEvent.click(await d.findByRole('button', { name: 'Agregar paso' }));
    await userEvent.selectOptions(d.getByLabelText('Qué hace'), 'fixed_text');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Paso 1: escribe el texto del mensaje o deja que lo escriba la IA.')).toBeInTheDocument();
    expect(w.puts).toHaveLength(0);
    await userEvent.click(d.getByLabelText('Texto del mensaje'));
    await userEvent.paste('  Hola {{primer_nombre}}, ¿sigues interesado?  ');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.puts[0]!.body).toMatchObject({ steps: [{ mode: 'fixed_text', fixed_text: 'Hola {{primer_nombre}}, ¿sigues interesado?' }] }));
  });

  it('un paso que solo inicia una automatización la exige; la espera mínima es de 5 minutos', async () => {
    const w: World = { fu: FU({ enabled: true }), puts: [] };
    mockApi(server(w));
    renderApp('/agents');
    const d = await openTab();
    await userEvent.click(await d.findByRole('button', { name: 'Agregar paso' }));
    await userEvent.selectOptions(d.getByLabelText('Qué hace'), 'none');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText(/elige la automatización/)).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText('Automatización que se inicia'), 'au1');
    const amount = d.getByLabelText('Esperar tras la respuesta del agente');
    await userEvent.clear(amount);
    await userEvent.type(amount, '2');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Paso 1: la espera debe ir de 5 minutos a 7 días.')).toBeInTheDocument();
    expect(w.puts).toHaveLength(0);
    await userEvent.clear(amount);
    await userEvent.type(amount, '10');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.puts[0]!.body).toEqual({ enabled: true, steps: [{ delay_minutes: 10, mode: 'none', fixed_text: null, start_automation_id: 'au1' }] }));
  });

  it('muestra lo guardado con la unidad más grande y el resumen de 7 días con los motivos; quita un paso; el tope es de 5', async () => {
    const w: World = {
      fu: FU({
        enabled: true,
        steps: [{ position: 1, delay_minutes: 120, mode: 'ai', fixed_text: null, start_automation_id: null }, { position: 2, delay_minutes: 2880, mode: 'fixed_text', fixed_text: 'Seguimos por aquí', start_automation_id: null }],
        summary: { sent: 4, skipped: 1, cancelled: 3, pending: 2, reasons: { client_replied: 3, window_closed: 1 } },
        updated_at: AT,
      }),
      puts: [],
    };
    mockApi(server(w));
    renderApp('/agents');
    const d = await openTab();
    expect((await d.findAllByDisplayValue('2')).length).toBe(2); // 120 min = 2 horas, 2880 min = 2 días
    expect(d.getAllByLabelText('Unidad').map((x) => (x as HTMLSelectElement).value)).toEqual(['hours', 'days']);
    const sum = within(d.getByRole('region', { name: 'Últimos 7 días' }));
    expect(sum.getByText(/4 enviados · 2 pendientes · 3 cancelados/)).toBeInTheDocument();
    expect(sum.getByText('3 × el cliente respondió')).toBeInTheDocument();
    expect(sum.getByText('1 × pasaron las 24 horas de WhatsApp')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Quitar el paso 2' }));
    expect(d.queryByText('Paso 2')).not.toBeInTheDocument();
    for (let i = 0; i < 4; i += 1) await userEvent.click(d.getByRole('button', { name: 'Agregar paso' }));
    expect(d.getByRole('button', { name: 'Agregar paso' })).toBeDisabled();
    expect(d.getByText('Máximo 5 pasos.')).toBeInTheDocument();
  });

  it('el motivo del servidor se muestra si rechaza el guardado', async () => {
    const w: World = { fu: FU({ enabled: true }), puts: [], fail: () => err(400, 'VALIDATION_ERROR', 'Variables no permitidas: {{telefono}}. Usa solo {{primer_nombre}}') };
    mockApi(server(w));
    renderApp('/agents');
    const d = await openTab();
    await userEvent.click(await d.findByRole('button', { name: 'Agregar paso' }));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByRole('alert')).toBeInTheDocument();
  });
});
