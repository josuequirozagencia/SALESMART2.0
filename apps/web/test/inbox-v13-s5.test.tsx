import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../src/features/inbox/MessageBubble';
import type { ChatMessage } from '../src/lib/types';

// v13 · S5b (ADR-70) — la transcripción por IA de una nota de voz se ve bajo el audio, con su aviso de que puede contener errores.

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const audio = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'audio', text: null, media: { mime_type: 'audio/ogg', filename: null }, extra: null, reaction: null, my_reaction: null, status: 'received', error: null,
  sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null,
  attachment: { id: 'a1', kind: 'audio', mime_type: 'audio/ogg', filename: null, size_bytes: 4000, scan_status: 'clean', state: 'ready', error: null, url: 'https://files.test/a1', expires_at: null },
  ...over,
} as ChatMessage);
const show = (m: ChatMessage) => render(<ul><MessageBubble m={m} canRetry={false} retrying={false} onRetry={() => undefined} contactName="Ana Torres" /></ul>);

describe('transcripción de una nota de voz (v13 S5b)', () => {
  it('muestra el texto bajo el reproductor con el aviso «Transcripción por IA · puede contener errores»', () => {
    show(audio({ transcript: { text: 'Hola, quiero agendar una cita para mañana', seconds: 7 } }));
    expect(screen.getByText('Transcripción por IA · puede contener errores')).toBeInTheDocument();
    expect(screen.getByText('Hola, quiero agendar una cita para mañana')).toBeInTheDocument();
  });

  it('sin transcripción no muestra nada de eso (un audio sin agente o con la opción apagada se ve como antes)', () => {
    show(audio());
    expect(screen.queryByText(/Transcripción por IA/)).not.toBeInTheDocument();
    const mine = show(audio({ transcript: null }));
    expect(mine.container.querySelectorAll('audio').length).toBeGreaterThan(0);
  });

  it('el texto transcrito se muestra como texto (no se interpreta como código)', () => {
    show(audio({ transcript: { text: '<img src=x onerror=alert(1)>', seconds: 2 } }));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
