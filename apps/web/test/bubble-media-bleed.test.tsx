import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../src/features/inbox/MessageBubble';
import type { ChatMessage } from '../src/lib/types';

const photo = { id: 'a1', kind: 'image', mime_type: 'image/jpeg', filename: null, size_bytes: 1000, scan_status: 'clean' as const, error: null, url: 'https://storage.test/a1', expires_at: null };
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'image', text: null, media: null, extra: null, reaction: null, my_reaction: null, status: 'received', error: null,
  sent_at: '2026-11-25T15:00:00.000Z', delivered_at: null, read_at: null, is_note: false, template: null, attachment: photo, ...over,
});
const show = (m: ChatMessage) => render(<ul><MessageBubble m={m} canRetry={false} retrying={false} onRetry={() => undefined} contactName="Ana" /></ul>);

describe('Imagen a borde de la burbuja (V23-B)', () => {
  it('con pie de foto: la imagen va primero, sin marco, y el texto DEBAJO; la hora va al pie, no sobre la foto', () => {
    const { container } = show(msg({ text: 'Prueba de foto' }));
    const img = screen.getByRole('img', { name: 'Imagen' });
    const caption = screen.getByText('Prueba de foto');
    expect(img.className).toContain('w-full');
    expect(img.className).not.toContain('rounded-lg');
    expect(img.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.bg-gradient-to-t')).toBeNull();
  });

  it('sin pie: la hora y los ticks van sobre la esquina de la foto con degradado oscuro', () => {
    const { container } = show(msg({ direction: 'out', sender_type: 'human', status: 'read' }));
    const overlay = container.querySelector('.bg-gradient-to-t');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('time')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Leído' })).toBeInTheDocument();
  });

  it('un archivo que aún se revisa no se muestra a borde: conserva su aviso', () => {
    show(msg({ attachment: { ...photo, scan_status: 'pending', url: null } }));
    expect(screen.getByText(/se está revisando/)).toBeInTheDocument();
  });
});

describe('Estado de entrega con íconos', () => {
  it.each([['sent', 'Enviado', 1], ['delivered', 'Entregado', 2], ['read', 'Leído', 2]] as const)('%s: %s con %i check(s)', (status, label, checks) => {
    show(msg({ kind: 'text', text: 'hola', attachment: null, direction: 'out', sender_type: 'human', status }));
    const t = screen.getByRole('img', { name: label });
    expect(t.querySelectorAll('path')).toHaveLength(checks);
    expect(t.className).toContain(status === 'read' ? 'tick-read' : 'tick-grey');
  });
});

describe('Cola de la burbuja', () => {
  it('solo la primera de un grupo lleva la esquina en pico', () => {
    const first = show(msg({ kind: 'text', text: 'uno', attachment: null }));
    expect(first.container.querySelector('.rounded-tl-sm')).not.toBeNull();
    first.unmount();
    const next = render(<ul><MessageBubble m={msg({ kind: 'text', text: 'dos', attachment: null })} tail={false} canRetry={false} retrying={false} onRetry={() => undefined} contactName="Ana" /></ul>);
    expect(next.container.querySelector('.rounded-tl-sm')).toBeNull();
  });
});
