import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/features/agents/useAgents';
import { dryRun, sizeLabel } from '../src/features/agents/FollowUpTab';
import type { FollowUpFile, FollowUps } from '../src/features/agents/useFollowUps';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-11-11T15:00:00.000Z';
const AGENT = {
  id: 'a1', name: 'Sofía', role: null, photo_url: null, cover: 'violet', active: true, model: 'gpt-4o-mini', channels: [], documents: 0, chunks: 0, created_at: AT,
  temperature: 0.3, max_tokens: 500, max_chars: 800, personality: 'Cálida', objective: '', extra_info: '', show_source: false, split_enabled: false, split_blocks: 2, transfer_enabled: true, transfer_queue_id: null, always_on: true,
  capture_fields: [], tasks_enabled: false, suggestions_enabled: false, read_images: false, transcribe_audio: false, document_ids: [], channel_ids: [], readiness: { instructions: true, documents: true, channel: true }, updated_at: AT,
} as Agent;
const OPTIONS = { models: ['gpt-4o-mini'], covers: ['violet'], limits: { max_agents: 20, max_photo_bytes: 1, max_chunks: 5000, max_capture_fields: 10 }, variables: [], channels: [], queues: [], capture_options: [], documents: [] };
const FU = (over: Partial<FollowUps> = {}): FollowUps => ({ scenario: 'stopped_replying', enabled: false, steps: [], loose_files: [], files_storage: { files: 0, bytes: 0, available: true, limits: { max_per_step: 3, max_mb: { image: 5, video: 16, audio: 16, document: 25 } } }, channels: { official: true, qr: false, ghl: false }, variables: ['primer_nombre', 'nombre', 'mi_nombre'], automations: [{ id: 'au1', name: 'Bienvenida' }], summary: { sent: 0, skipped: 0, cancelled: 0, pending: 0, reasons: {} }, updated_at: null, ...over });

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
      w.fu = FU({ enabled: b.enabled, steps: b.steps.map((s, i) => ({ position: i + 1, delay_minutes: s.delay_minutes, mode: s.mode, fixed_text: s.fixed_text ?? null, start_automation_id: s.start_automation_id ?? null, files: [] })), updated_at: new Date().toISOString() });
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
        steps: [{ position: 1, delay_minutes: 120, mode: 'ai', fixed_text: null, start_automation_id: null, files: [] }, { position: 2, delay_minutes: 2880, mode: 'fixed_text', fixed_text: 'Seguimos por aquí', start_automation_id: null, files: [] }],
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

// ═════════════════════════════════════════════════════════════════════════════ v15 — archivos en los pasos de texto fijo
const FILE = (over: Partial<FollowUpFile> = {}): FollowUpFile => ({ id: 'f1', kind: 'image', mime_type: 'image/jpeg', filename: 'catalogo.jpg', size_bytes: 150_000, scan_status: 'clean', step_position: null, sort_order: 0, ...over });
const FIXED = (over: Partial<FollowUps['steps'][number]> = {}): FollowUps['steps'][number] => ({ position: 1, delay_minutes: 30, mode: 'fixed_text', fixed_text: 'Te dejo el catálogo', start_automation_id: null, files: [], ...over });
function fileServer(w: World, up: () => ReturnType<Handler>): Record<string, Handler> {
  return {
    ...server(w),
    'POST /agents/a1/follow-ups/files': up,
    'GET /agents/a1/follow-ups/files/f1/url': () => ({ body: { url: 'https://files.test/f1.jpg', expires_at: AT, kind: 'image', mime_type: 'image/jpeg', filename: 'catalogo.jpg' } }),
    'DELETE /agents/a1/follow-ups/files/f1': () => ({ body: w.fu }),
  };
}

describe('funciones puras de los archivos de un paso (v15)', () => {
  it('el tamaño se dice en KB hasta 1 MB y en MB después', () => {
    expect(sizeLabel(500)).toBe('1 KB');
    expect(sizeLabel(150_000)).toBe('146 KB');
    expect(sizeLabel(2 * 1024 * 1024)).toBe('2 MB');
    expect(sizeLabel(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(sizeLabel(20 * 1024 * 1024)).toBe('20 MB');
  });
  it('en seco: el texto va de pie del primer archivo; con un audio primero, en un mensaje aparte antes', () => {
    expect(dryRun('Hola', [])).toEqual([]);
    expect(dryRun('Hola', [FILE(), FILE({ id: 'f2', kind: 'document', filename: 'precios.pdf' })])).toEqual(['Imagen «catalogo.jpg» con el texto de pie', 'Documento «precios.pdf»']);
    expect(dryRun('Hola', [FILE({ kind: 'audio', filename: 'saludo.ogg' }), FILE({ id: 'f2' })])).toEqual(['Un mensaje con el texto', 'Audio «saludo.ogg»', 'Imagen «catalogo.jpg»']);
  });
});

describe('Agente · archivos de un paso de texto fijo (v15)', () => {
  it('un paso de texto fijo ofrece «Adjuntar archivo»; sube el archivo, lo muestra con su vista previa, tamaño y estado, dice qué se enviará y al guardar manda sus ids', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED()] }), puts: [] };
    mockApi(fileServer(w, () => ({ status: 201, body: FILE() })));
    renderApp('/agents');
    const d = await openTab();
    await userEvent.upload(await d.findByLabelText('Adjuntar archivo al paso 1'), new File(['x'], 'catalogo.jpg', { type: 'image/jpeg' }));
    const list = within(await d.findByRole('list', { name: 'Archivos adjuntos del paso 1' }));
    expect(list.getByText('catalogo.jpg')).toBeInTheDocument();
    expect(list.getByText(/Imagen · 146 KB/)).toBeInTheDocument();
    expect(list.getByText('Listo (revisado)')).toBeInTheDocument();
    expect(await list.findByAltText('Vista previa de catalogo.jpg')).toHaveAttribute('src', 'https://files.test/f1.jpg');
    expect(d.getByText(/Imagen «catalogo.jpg» con el texto de pie/)).toBeInTheDocument();
    expect(d.getByText(/Hasta 3 archivos por paso: imágenes \(JPG, PNG\) de hasta 5 MB, videos de hasta 16 MB/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.puts[0]!.body).toMatchObject({ steps: [{ mode: 'fixed_text', file_ids: ['f1'] }] }));
  });

  it('un archivo que el antivirus no pudo revisar (no hay antivirus) se ve «sin revisar»', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED({ files: [FILE({ scan_status: 'skipped', step_position: 1 })] })] }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findByText('Listo (sin revisar: no hay antivirus)')).toBeInTheDocument();
  });

  it('el máximo es de 3 archivos por paso: con 3 el botón se desactiva y lo dice', async () => {
    const files = [FILE({ id: 'f1', step_position: 1 }), FILE({ id: 'f2', step_position: 1, filename: 'b.jpg' }), FILE({ id: 'f3', step_position: 1, filename: 'c.jpg' })];
    const w: World = { fu: FU({ enabled: true, steps: [FIXED({ files })] }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findByLabelText('Adjuntar archivo al paso 1')).toBeDisabled();
    expect(d.getByText(/Este paso ya tiene el máximo/)).toBeInTheDocument();
  });

  it('un error del servidor al subir (por ejemplo, el tamaño) se muestra tal cual, en español', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED()] }), puts: [] };
    mockApi(fileServer(w, () => err(413, 'ATTACHMENT_TOO_LARGE', 'El video pesa 20 MB; WhatsApp permite hasta 16 MB')));
    renderApp('/agents');
    const d = await openTab();
    await userEvent.upload(await d.findByLabelText('Adjuntar archivo al paso 1'), new File(['x'], 'promo.mp4', { type: 'video/mp4' }));
    expect(await d.findByText('El video pesa 20 MB; WhatsApp permite hasta 16 MB')).toBeInTheDocument();
  });

  it('quitar con la X borra el archivo en el servidor y lo saca de la lista', async () => {
    const calls: string[] = [];
    const w: World = { fu: FU({ enabled: true, steps: [FIXED({ files: [FILE({ step_position: 1 })] })] }), puts: [] };
    const routes = fileServer(w, () => err(500, 'X'));
    routes['DELETE /agents/a1/follow-ups/files/f1'] = () => { calls.push('delete'); return { body: w.fu }; };
    mockApi(routes);
    renderApp('/agents');
    const d = await openTab();
    await userEvent.click(await d.findByRole('button', { name: 'Quitar el archivo catalogo.jpg' }));
    await waitFor(() => expect(calls).toEqual(['delete']));
    await waitFor(() => expect(d.queryByRole('list', { name: 'Archivos adjuntos del paso 1' })).not.toBeInTheDocument());
  });

  it('WhatsApp oficial: un paso que cae pasadas 24 h de espera acumulada no admite archivos (aviso y botón desactivado); guardar con archivos ahí se frena antes de enviar', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [{ position: 1, delay_minutes: 600, mode: 'ai', fixed_text: null, start_automation_id: null, files: [] }, FIXED({ position: 2, delay_minutes: 900, files: [FILE({ step_position: 2 })] })] }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findAllByText(/Después de 24 h por WhatsApp oficial solo puedes enviar una plantilla/)).not.toHaveLength(0);
    expect(d.getByLabelText('Adjuntar archivo al paso 2')).toBeDisabled();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect((await d.findByRole('alert')).textContent).toMatch(/Paso 2: Después de 24 h por WhatsApp oficial/);
    expect(w.puts).toHaveLength(0);
  });

  it('por QR no hay ventana: el mismo paso lejano sí admite archivos', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED({ delay_minutes: 3000 })], channels: { official: false, qr: true, ghl: false } }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findByLabelText('Adjuntar archivo al paso 1')).toBeEnabled();
  });

  it('con GoHighLevel conectado el botón está desactivado y dice por qué', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED()], channels: { official: false, qr: false, ghl: true } }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findByLabelText('Adjuntar archivo al paso 1')).toBeDisabled();
    expect(d.getByText(/Por GoHighLevel solo se pueden enviar mensajes de texto/)).toBeInTheDocument();
  });

  it('sin almacenamiento de archivos el botón está desactivado y lo explica; los pasos de IA no ofrecen archivos', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED(), { position: 2, delay_minutes: 60, mode: 'ai', fixed_text: null, start_automation_id: null, files: [] }], files_storage: { files: 0, bytes: 0, available: false, limits: { max_per_step: 3, max_mb: { image: 5, video: 16, audio: 16, document: 25 } } } }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    expect(await d.findByLabelText('Adjuntar archivo al paso 1')).toBeDisabled();
    expect(d.getByText(/Todavía no hay almacenamiento de archivos configurado/)).toBeInTheDocument();
    expect(d.queryByLabelText('Adjuntar archivo al paso 2')).not.toBeInTheDocument();
  });

  it('cambiar un paso con archivos a «La IA escribe el mensaje» los saca del paso (la IA no elige archivos)', async () => {
    const w: World = { fu: FU({ enabled: true, steps: [FIXED({ files: [FILE({ step_position: 1 })] })] }), puts: [] };
    mockApi(fileServer(w, () => err(500, 'X')));
    renderApp('/agents');
    const d = await openTab();
    await userEvent.selectOptions(await d.findByLabelText('Qué hace'), 'ai');
    expect(d.queryByLabelText('Adjuntar archivo al paso 1')).not.toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.puts[0]!.body).toEqual({ enabled: true, steps: [{ delay_minutes: 30, mode: 'ai', fixed_text: null, start_automation_id: null }] }));
  });
});
