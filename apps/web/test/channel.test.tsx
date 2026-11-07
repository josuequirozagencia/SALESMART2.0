import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactAttribution } from '../src/lib/types';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const attr = (over: Partial<ContactAttribution> = {}): ContactAttribution => ({ ctwa_cl_id: 'AbC123', channel: 'instagram', first_touch: null, last_touch: { at: '2026-10-12T15:00:00.000Z', source: 'meta_ctwa', campaign: 'Barbería', adset: 'Conjunto B', ad: 'Anuncio 2' }, capi: null, ...over });
const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1', name: 'Ana Torres', email: null, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'meta_ctwa', channel: 'instagram', consent: 'unknown', consent_updated_at: null,
  custom_fields: {}, tags: [], companies: [], attribution: attr(), created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});
const contactsServer = (c: Contact): Record<string, Handler> => ({
  ...authed(ME_ADMIN),
  'GET /contacts': () => ({ body: { items: [c], next_cursor: null, total: 1, access: { view_all: true, write: true, delete: true, import: true, export: true } } }),
  'GET /contacts/owners': () => ({ body: { items: [] } }),
});

describe('Canal del lead (M3.3 §11)', () => {
  it('la sección «Origen del lead» muestra la insignia del canal', async () => {
    mockApi(contactsServer(contact()));
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    const o = within(d.getByRole('region', { name: 'Origen del lead' }));
    expect(within(o.getByLabelText('Canal del lead')).getByText('Instagram')).toBeInTheDocument();
  });

  it.each([
    ['facebook', 'Facebook'],
    ['whatsapp', 'WhatsApp'],
    ['manual', 'Manual'],
    ['other', 'Otro canal'],
  ] as const)('la insignia del canal %s dice «%s»', async (channel, label) => {
    mockApi(contactsServer(contact({ channel, attribution: attr({ channel }) })));
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const o = within((await screen.findByRole('dialog', { name: 'Contacto' })).querySelector('[aria-label="Canal del lead"]') as HTMLElement);
    expect(o.getByText(label)).toBeInTheDocument();
  });

  it('la columna «Canal» es opcional: se agrega desde «Columnas» y muestra la insignia', async () => {
    mockApi(contactsServer(contact({ attribution: null, channel: 'whatsapp' })));
    renderApp('/contacts');
    const table = await screen.findByRole('table', { name: 'Contactos' });
    expect(within(table).queryByRole('columnheader', { name: 'Canal' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Columnas/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Canal' }));
    expect(within(await screen.findByRole('table', { name: 'Contactos' })).getByRole('columnheader', { name: 'Canal' })).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Contactos' })).getByText('WhatsApp')).toBeInTheDocument();
  });
});
