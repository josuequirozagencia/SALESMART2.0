import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDoc, KnowledgePage, SearchHit } from '../src/features/knowledge/useKnowledge';
import { authed, err, ME_ADMIN, ME_ROOT, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-10-26T15:00:00.000Z';
const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const doc = (over: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({ id: 'd1', name: 'horarios.txt', kind: 'txt', size_bytes: 2048, status: 'ready', error_code: null, error_message: null, active: true, chunk_count: 3, created_at: AT, updated_at: AT, can_reprocess: true, ...over });
const LIMITS = { max_bytes: 10 * 1024 * 1024, max_documents: 200, kinds: ['txt', 'csv', 'pdf', 'docx'] as const, chunks_used: 12, chunks_max: 5000 };

interface World { docs: KnowledgeDoc[]; calls: Record<string, Call[]>; hits: SearchHit[]; uploadFails?: (name: string) => ReturnType<Handler> | null }
const world = (over: Partial<World> = {}): World => ({ docs: [doc()], calls: {}, hits: [], ...over });
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };

function server(w: World): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /knowledge/documents': (c) => { rec(w, 'list', c); return { body: { items: w.docs, next_cursor: null, limits: { ...LIMITS, kinds: [...LIMITS.kinds] } } satisfies KnowledgePage }; },
    'POST /knowledge/documents': (c) => {
      rec(w, 'upload', c);
      const n = w.docs.length + 1;
      const created = doc({ id: `n${n}`, name: `nuevo-${n}.txt`, status: 'pending', chunk_count: 0, can_reprocess: false });
      w.docs = [created, ...w.docs];
      return { status: 201, body: created };
    },
    'POST /knowledge/search': (c) => { rec(w, 'search', c); return { body: { hits: w.hits } }; },
  };
  for (const d of ['d1', 'd2', 'd3']) {
    routes[`PATCH /knowledge/documents/${d}`] = (c) => { rec(w, 'patch', c); const b = c.body as { active: boolean }; w.docs = w.docs.map((x) => (x.id === d ? { ...x, active: b.active } : x)); return { body: w.docs.find((x) => x.id === d) }; };
    routes[`POST /knowledge/documents/${d}/reprocess`] = (c) => { rec(w, 'reprocess', c); w.docs = w.docs.map((x) => (x.id === d ? { ...x, status: 'pending', error_code: null, error_message: null, can_reprocess: false } : x)); return { body: w.docs.find((x) => x.id === d) }; };
    routes[`DELETE /knowledge/documents/${d}`] = (c) => { rec(w, 'delete', c); w.docs = w.docs.filter((x) => x.id !== d); return { body: { id: d, deleted: true } }; };
  }
  return routes;
}
const list = async () => within(await screen.findByRole('list', { name: 'Documentos' }));

describe('Configuración › Conocimiento', () => {
  it('muestra los documentos con su estado, tipo, tamaño y fragmentos, y los límites; el menú tiene la pestaña', async () => {
    const w = world({ docs: [doc(), doc({ id: 'd2', name: 'precios.csv', kind: 'csv', size_bytes: 400, status: 'processing', chunk_count: 0, can_reprocess: false }), doc({ id: 'd3', name: 'escaneado.pdf', kind: 'pdf', status: 'error', error_code: 'empty', error_message: 'El PDF no tiene texto que se pueda leer (¿es una imagen escaneada?)', chunk_count: 0 })] });
    mockApi(server(w));
    renderApp('/settings/knowledge');
    const l = await list();
    expect(l.getAllByRole('listitem')).toHaveLength(3);
    expect(l.getByText('horarios.txt')).toBeInTheDocument();
    expect(l.getByText('Listo')).toBeInTheDocument();
    expect(l.getByText('Procesando')).toBeInTheDocument();
    expect(l.getByText('Con error')).toBeInTheDocument();
    expect(l.getByText(/Texto · 2 KB · 3 fragmentos/)).toBeInTheDocument();
    expect(l.getByText(/imagen escaneada/)).toBeInTheDocument();
    expect(screen.getByText(/3 documentos de 200 · 12 de 5.000 fragmentos usados/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Conocimiento' })).toHaveAttribute('href', '/settings/knowledge');
  });

  it('sin documentos invita a subir el primero', async () => {
    mockApi(server(world({ docs: [] })));
    renderApp('/settings/knowledge');
    expect(await screen.findByText(/Aún no hay documentos/)).toBeInTheDocument();
  });

  it('subir: manda el archivo tal cual con su nombre y aparece en la lista como «En fila»; varios archivos van uno por uno', async () => {
    const w = world({ docs: [] });
    mockApi(server(w));
    renderApp('/settings/knowledge');
    const input = await screen.findByLabelText('Elegir documentos');
    const a = new File(['hola mundo'], 'uno.txt', { type: 'text/plain' });
    const b = new File(['otro texto largo'], 'dos.csv', { type: 'text/csv' });
    await userEvent.upload(input, [a, b]);
    await waitFor(() => expect(w.calls['upload']).toHaveLength(2));
    expect(w.calls['upload']![0]!.headers['x-filename']).toBe('uno.txt');
    expect(w.calls['upload']![1]!.headers['x-filename']).toBe('dos.csv');
    expect(w.calls['upload']![0]!.headers['content-type']).toBe('application/octet-stream');
    expect(w.calls['upload']![0]!.body).toEqual({ raw_bytes: 10 });
    expect(w.calls['upload']![1]!.body).toEqual({ raw_bytes: 16 });
    const l = await list();
    await waitFor(() => expect(l.getAllByRole('listitem')).toHaveLength(2));
    expect(l.getAllByText('En fila')).toHaveLength(2);
  });

  it('un archivo rechazado por el servidor muestra el motivo con su nombre y no impide subir los demás', async () => {
    const w = world({ docs: [] });
    const routes = server(w);
    let n = 0;
    routes['POST /knowledge/documents'] = (c) => {
      rec(w, 'upload', c);
      n += 1;
      if (n === 1) return err(415, 'DOCUMENT_UNSUPPORTED', 'Ese tipo de archivo no se puede usar: sube un PDF, un Word (.docx), un texto (.txt) o una tabla (.csv)');
      const created = doc({ id: 'n2', name: 'bueno.txt', status: 'pending', can_reprocess: false });
      w.docs = [created];
      return { status: 201, body: created };
    };
    mockApi(routes);
    renderApp('/settings/knowledge');
    // el selector filtra por extensión; el servidor es quien decide, así que aquí se salta ese filtro del navegador
    await userEvent.setup({ applyAccept: false }).upload(await screen.findByLabelText('Elegir documentos'), [new File(['x'], 'foto.png', { type: 'image/png' }), new File(['y'], 'bueno.txt', { type: 'text/plain' })]);
    expect(await screen.findByText(/foto.png: Ese tipo de archivo no se puede usar/)).toBeInTheDocument();
    await waitFor(() => expect(w.calls['upload']).toHaveLength(2));
    expect(await (await list()).findByText('bueno.txt')).toBeInTheDocument();
  });

  it('activar o desactivar un documento manda el cambio; reprocesar lo vuelve a poner en fila', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/knowledge');
    const check = await screen.findByRole('checkbox', { name: 'Usar «horarios.txt» en las respuestas' });
    expect(check).toBeChecked();
    await userEvent.click(check);
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ active: false }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Usar «horarios.txt» en las respuestas' })).not.toBeChecked());
    await userEvent.click(screen.getByRole('button', { name: 'Reprocesar «horarios.txt»' }));
    await waitFor(() => expect(w.calls['reprocess']).toHaveLength(1));
    expect(await (await list()).findByText('En fila')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reprocesar «horarios.txt»' })).toBeNull();
  });

  it('borrar pide confirmación; «No» la cancela y «Sí, borrar» lo quita de la lista', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/knowledge');
    await userEvent.click(await screen.findByRole('button', { name: 'Borrar «horarios.txt»' }));
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(w.calls['delete']).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Borrar «horarios.txt»' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.calls['delete']).toHaveLength(1));
    expect(await screen.findByText(/Aún no hay documentos/)).toBeInTheDocument();
  });

  it('un documento esperando a que la IA esté configurada se explica con claridad', async () => {
    mockApi(server(world({ docs: [doc({ status: 'pending', error_code: 'waiting', error_message: 'Esperando a que el servicio de IA esté configurado', chunk_count: 0, can_reprocess: true })] })));
    renderApp('/settings/knowledge');
    const l = await list();
    expect(l.getByText('Esperando a la IA')).toBeInTheDocument();
    expect(l.getByText('Esperando a que el servicio de IA esté configurado')).toBeInTheDocument();
  });

  it('mientras algún documento se procesa, la lista se vuelve a pedir sola', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = world({ docs: [doc({ status: 'processing', chunk_count: 0, can_reprocess: false })] });
      mockApi(server(w));
      renderApp('/settings/knowledge');
      await list();
      expect(w.calls['list']).toHaveLength(1);
      w.docs = [doc()]; // ya terminó
      await vi.advanceTimersByTimeAsync(5_500);
      await waitFor(() => expect(w.calls['list']!.length).toBeGreaterThanOrEqual(2));
      expect(await (await list()).findByText('Listo')).toBeInTheDocument();
      const n = w.calls['list']!.length;
      await vi.advanceTimersByTimeAsync(12_000);
      expect(w.calls['list']!.length).toBe(n); // ya nada pendiente: no sigue preguntando
    } finally {
      vi.useRealTimers();
    }
  });

  it('si el servidor lo niega (sin permiso) muestra el motivo', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /knowledge/documents': () => err(403, 'FORBIDDEN', 'No tienes permiso') });
    renderApp('/settings/knowledge');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Configuración › Conocimiento · probar la búsqueda', () => {
  const box = async () => within(await screen.findByRole('region', { name: 'Probar la búsqueda' }));

  it('muestra los fragmentos encontrados con su documento y el parecido', async () => {
    const w = world({ hits: [{ document: { id: 'd1', name: 'horarios.txt' }, content: 'Abrimos de lunes a viernes de 9 a 18.', score: 0.62 }] });
    mockApi(server(w));
    renderApp('/settings/knowledge');
    const b = await box();
    await userEvent.type(b.getByLabelText('Pregunta'), '¿Cuál es el horario?');
    await userEvent.click(b.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(w.calls['search']![0]!.body).toEqual({ query: '¿Cuál es el horario?' }));
    const results = within(await b.findByRole('list', { name: 'Resultados' }));
    expect(results.getByText('horarios.txt')).toBeInTheDocument();
    expect(results.getByText('Parecido 62 %')).toBeInTheDocument();
    expect(results.getByText('Abrimos de lunes a viernes de 9 a 18.')).toBeInTheDocument();
  });

  it('sin resultados explica que la IA no afirmaría nada (sin respaldo no se inventa)', async () => {
    mockApi(server(world({ hits: [] })));
    renderApp('/settings/knowledge');
    const b = await box();
    await userEvent.type(b.getByLabelText('Pregunta'), 'receta de ceviche');
    await userEvent.click(b.getByRole('button', { name: 'Buscar' }));
    expect(await b.findByText(/la IA no respondería con datos sobre esto/)).toBeInTheDocument();
  });

  it('una pregunta vacía no se envía; sin créditos o sin IA muestra el motivo del servidor', async () => {
    const w = world();
    const routes = server(w);
    routes['POST /knowledge/search'] = (c) => { rec(w, 'search', c); return err(409, 'AI_NO_CREDITS', 'No hay créditos suficientes para esta operación'); };
    mockApi(routes);
    renderApp('/settings/knowledge');
    const b = await box();
    await userEvent.click(b.getByRole('button', { name: 'Buscar' }));
    expect(await b.findByRole('alert')).toHaveTextContent('Escribe una pregunta.');
    expect(w.calls['search']).toBeUndefined();
    await userEvent.type(b.getByLabelText('Pregunta'), 'horario');
    await userEvent.click(b.getByRole('button', { name: 'Buscar' }));
    expect(await b.findByText('No hay créditos suficientes para esta operación')).toBeInTheDocument();
  });
});

describe('Plataforma › Modelos de IA', () => {
  interface PW { models: Array<{ model: string; kind: 'embedding' | 'chat'; usd_per_1m_input: string; usd_per_1m_output: string; updated_at: string }>; puts: unknown[] }
  const pw = (): PW => ({ models: [{ model: 'gpt-4o-mini', kind: 'chat', usd_per_1m_input: '0.150000', usd_per_1m_output: '0.600000', updated_at: AT }, { model: 'text-embedding-3-small', kind: 'embedding', usd_per_1m_input: '0.020000', usd_per_1m_output: '0.000000', updated_at: AT }], puts: [] });
  const srv = (w: PW): Record<string, Handler> => ({
    ...authed(ME_ROOT),
    'GET /platform/trials': () => ({ body: NO_TRIALS }),
    'GET /platform/ai/organizations': () => ({ body: { items: [], next_cursor: null, pricing: { usd_per_credit: '0.010000', global_margin_pct: '100.00', updated_at: AT } } }),
    'GET /platform/ai/models': () => ({ body: w.models }),
    'PUT /platform/ai/models/gpt-4o-mini': (c) => { w.puts.push(c.body); return { body: { ...w.models[0], ...(c.body as object) } }; },
  });

  it('lista los modelos con su precio y permite cambiarlo; valida antes de enviar', async () => {
    const w = pw();
    mockApi(srv(w));
    renderApp('/platform/ai');
    const form = within(await screen.findByRole('form', { name: 'Precio de gpt-4o-mini' }));
    expect(form.getByLabelText('Entrada (USD por millón de tokens)')).toHaveValue('0.15');
    expect(form.getByLabelText('Salida (USD por millón de tokens)')).toHaveValue('0.6');
    expect(screen.getByRole('form', { name: 'Precio de text-embedding-3-small' })).toBeInTheDocument();
    await userEvent.clear(form.getByLabelText('Entrada (USD por millón de tokens)'));
    await userEvent.type(form.getByLabelText('Entrada (USD por millón de tokens)'), '20000');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(await form.findByRole('alert')).toHaveTextContent(/0 a 10000/);
    expect(w.puts).toHaveLength(0);
    await userEvent.clear(form.getByLabelText('Entrada (USD por millón de tokens)'));
    await userEvent.type(form.getByLabelText('Entrada (USD por millón de tokens)'), '0.2');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.puts).toEqual([{ usd_per_1m_input: '0.2', usd_per_1m_output: '0.6' }]));
    expect(await form.findByText('Precio guardado.')).toBeInTheDocument();
  });
});
