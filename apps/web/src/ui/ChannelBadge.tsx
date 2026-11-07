import type { ContactChannel } from '../lib/types';

const LABEL: Record<ContactChannel, string> = { facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp', manual: 'Manual', other: 'Otro canal' };
export const channelLabel = (c: ContactChannel | undefined): string => LABEL[c ?? 'manual'] ?? LABEL.other;

/** Ícono pequeño de cada canal, decorativo (el texto lo dice). Colores de marca fijos: no cambian con el tema, pero el texto de la insignia sí. */
function ChannelIcon({ channel }: { channel: ContactChannel }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true as const, className: 'shrink-0' };
  switch (channel) {
    case 'facebook':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="8" fill="#1877f2" />
          <path d="M8.9 13V8.6h1.5l.2-1.7H8.9V5.9c0-.5.1-.8.8-.8h.9V3.6c-.2 0-.7-.1-1.3-.1-1.3 0-2.2.8-2.2 2.2v1.2H5.6v1.7h1.5V13h1.8z" fill="#fff" />
        </svg>
      );
    case 'instagram':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="ss-ig" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#f58529" />
              <stop offset="0.5" stopColor="#dd2a7b" />
              <stop offset="1" stopColor="#8134af" />
            </linearGradient>
          </defs>
          <rect width="16" height="16" rx="4.5" fill="url(#ss-ig)" />
          <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2.6" fill="none" stroke="#fff" strokeWidth="1.2" />
          <circle cx="8" cy="8" r="2.1" fill="none" stroke="#fff" strokeWidth="1.2" />
          <circle cx="10.7" cy="5.3" r=".7" fill="#fff" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="8" fill="#25d366" />
          <path d="M4.6 11.4l.5-1.7a3.7 3.7 0 1 1 1.4 1.3l-1.9.4zm2.2-5.3c-.1-.2-.3-.2-.4-.2-.2 0-.4.2-.5.4-.2.4 0 .9.3 1.3.5.8 1.2 1.4 2 1.7.5.2 1 .1 1.2-.3l.1-.4c0-.1-.5-.4-.7-.4l-.4.4c-.6-.2-1.1-.8-1.3-1.2l.3-.3c.1-.1.1-.2 0-.4l-.6-.6z" fill="#fff" />
        </svg>
      );
    case 'manual':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4 3 13z" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.5v3M8 10.6v.1" />
        </svg>
      );
  }
}

/** Insignia del canal de entrada del lead: ícono y texto. */
export function ChannelBadge({ channel }: { channel: ContactChannel | undefined }) {
  const c = channel ?? 'manual';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-semibold text-fg">
      <ChannelIcon channel={c} />
      {channelLabel(c)}
    </span>
  );
}
