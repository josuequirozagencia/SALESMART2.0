import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactQuickActions, type ContactTab } from '../src/features/contacts/ContactQuickActions';
import { err, mockApi, resetWorld } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const Probe = () => <p data-testid="where">{useLocation().pathname}</p>;

function mount(tags: unknown[] = [], onOpenTab: (t: ContactTab) => void = () => undefined) {
  return render(
    <MemoryRouter initialEntries={['/contacts']}>
      <Routes>
        <Route path="*" element={<><ContactQuickActions contact={{ id: 'c1', name: 'Ana Torres', tags }} onOpenTab={onOpenTab} /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Acciones rápidas del contacto (v11 S2)', () => {
  it('trae las seis acciones con nombre accesible; el teléfono está inactivo y dice por qué', () => {
    mockApi({});
    mount();
    const group = screen.getByRole('group', { name: 'Acciones rápidas de Ana Torres' });
    expect(group).toBeInTheDocument();
    const phone = screen.getByRole('button', { name: 'Llamar a Ana Torres' });
    expect(phone).toBeDisabled();
    expect(phone).toHaveAttribute('title', 'Llamadas aún no disponibles');
    for (const n of ['Abrir la conversación con Ana Torres', 'Etiquetas de Ana Torres', 'Notas de Ana Torres', 'Tareas de Ana Torres', 'Citas de Ana Torres']) {
      expect(screen.getByRole('button', { name: n })).toBeEnabled();
    }
  });

  it('el conteo de etiquetas se ve solo si hay etiquetas', () => {
    mockApi({});
    const { unmount } = mount([]);
    expect(screen.queryByText('2')).not.toBeInTheDocument();
    unmount();
    mount([{}, {}]);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('Mensaje pide la conversación al servidor y abre esa conversación en el Inbox', async () => {
    const calls: string[] = [];
    mockApi({ 'GET /contacts/c1/conversation': () => { calls.push('GET'); return { body: { conversation_id: 'v7' } }; } });
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la conversación con Ana Torres' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/inbox/v7'));
    expect(calls).toEqual(['GET']);
  });

  it('sin conversaciones (404) el icono queda deshabilitado con «Sin conversaciones» y no navega', async () => {
    mockApi({ 'GET /contacts/c1/conversation': () => err(404, 'NO_CONVERSATION') });
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la conversación con Ana Torres' }));
    const off = await screen.findByRole('button', { name: 'Sin conversaciones con Ana Torres' });
    expect(off).toBeDisabled();
    expect(off).toHaveAttribute('title', 'Sin conversaciones');
    expect(screen.getByTestId('where')).toHaveTextContent('/contacts');
  });

  it('un error del servidor no deshabilita el icono: se puede reintentar', async () => {
    mockApi({ 'GET /contacts/c1/conversation': () => err(500, 'INTERNAL') });
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la conversación con Ana Torres' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abrir la conversación con Ana Torres' })).toHaveAttribute('title', expect.stringContaining('inténtalo de nuevo')));
    expect(screen.getByRole('button', { name: 'Abrir la conversación con Ana Torres' })).toBeEnabled();
  });

  it('Etiquetas, Nota, Tarea y Calendario piden la sección correspondiente de la ficha', async () => {
    mockApi({});
    const tabs: ContactTab[] = [];
    mount([], (t) => tabs.push(t));
    for (const n of ['Etiquetas de Ana Torres', 'Notas de Ana Torres', 'Tareas de Ana Torres', 'Citas de Ana Torres']) await userEvent.click(screen.getByRole('button', { name: n }));
    expect(tabs).toEqual(['data', 'notes', 'tasks', 'agenda']);
  });
});

describe('Ficha del contacto abierta desde una tarjeta (v11 S2)', () => {
  it('abre en la sección «Citas» y lista las del contacto con la hora de la empresa', async () => {
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { createQueryClient } = await import('../src/lib/query');
    const { ContactDialogHost } = await import('../src/features/contacts/ContactDialogHost');
    const contact = { id: 'c1', name: 'Ana Torres', email: null, phones: [], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], companies: [], attribution: null, created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z' };
    const appt = { id: 'a1', contact: { id: 'c1', name: 'Ana Torres' }, conversation_id: null, owner: { id: 'u1', name: 'Luis Navas' }, starts_at: '2026-12-15T15:00:00.000Z', ends_at: '2026-12-15T15:30:00.000Z', duration_minutes: 30, kind: 'Consulta', notes: null, status: 'scheduled', cancel_reason: null, created_at: '2026-11-01T10:00:00.000Z', reminders: [], reminder_offsets: [], reminder_template: null, can: { edit: true, cancel: true, complete: true } };
    mockApi({
      'GET /contacts/c1': () => ({ body: contact }),
      'GET /contacts/owners': () => ({ body: { items: [] } }),
      'GET /appointments': () => ({ body: { items: [appt], timezone: 'America/Guayaquil' } }),
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ContactDialogHost contactId="c1" tab="agenda" onClose={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const panel = await screen.findByRole('region', { name: 'Citas del contacto' });
    expect(panel).toHaveTextContent('Agendada');
    expect(panel).toHaveTextContent('30 min · Consulta · Luis Navas');
    expect(panel).toHaveTextContent(/15 dic 2026/);
    expect(panel).toHaveTextContent(/10:00/); // 15:00 UTC = 10:00 en Guayaquil
    expect(screen.getByRole('tab', { name: 'Citas' })).toHaveAttribute('aria-selected', 'true');
  });
});
