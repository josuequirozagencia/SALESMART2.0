import { useCallback, useSyncExternalStore, type CSSProperties } from 'react';
import { useSession } from '../lib/session';

/**
 * Fondo del chat (v5): por persona Y empresa, en este navegador (`ss.chatbg.v1:<userId>:<orgId>`; sin endpoint). Cuatro opciones: `default` (patrón suave propio sobre el color del tema), `plain`
 * (color liso del tema), `color` (uno de seis, mezclado con la superficie para que siga al modo claro/oscuro) y `none` (el fondo de la aplicación). Todo acceso al almacenamiento va en
 * try/catch y lo leído se valida; sin almacenamiento la elección vale mientras la página siga abierta.
 */
export type ChatBgKind = 'default' | 'plain' | 'color' | 'none';
export interface ChatBgPref {
  kind: ChatBgKind;
  color: string;
}
export const CHAT_BG_KINDS: ReadonlyArray<{ id: ChatBgKind; label: string; hint: string }> = [
  { id: 'default', label: 'Predeterminado', hint: 'Patrón suave que sigue el tema' },
  { id: 'plain', label: 'Liso', hint: 'Sin patrón' },
  { id: 'color', label: 'Color', hint: 'Uno de seis colores' },
  { id: 'none', label: 'Ninguno', hint: 'El color de fondo de la aplicación' },
];
export const CHAT_BG_COLORS: ReadonlyArray<{ id: string; label: string; hue: string }> = [
  { id: 'whatsapp', label: 'Verde WhatsApp', hue: '#25d366' },
  { id: 'azul', label: 'Azul', hue: '#3b82f6' },
  { id: 'violeta', label: 'Violeta', hue: '#8b5cf6' },
  { id: 'rosa', label: 'Rosa', hue: '#ec4899' },
  { id: 'ambar', label: 'Ámbar', hue: '#f59e0b' },
  { id: 'gris', label: 'Gris', hue: '#94a3b8' },
];
export const DEFAULT_CHAT_BG: ChatBgPref = { kind: 'default', color: 'whatsapp' };

export const chatBgKey = (userId: string, orgId: string): string => `ss.chatbg.v1:${userId}:${orgId}`;

export function parseChatBg(raw: string | null): ChatBgPref {
  if (!raw) return DEFAULT_CHAT_BG;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return DEFAULT_CHAT_BG;
    const r = v as Record<string, unknown>;
    const kind = CHAT_BG_KINDS.find((k) => k.id === r['kind'])?.id ?? 'default';
    const color = CHAT_BG_COLORS.find((c) => c.id === r['color'])?.id ?? 'whatsapp';
    return { kind, color };
  } catch {
    return DEFAULT_CHAT_BG;
  }
}

/** Cómo se pinta el fondo: una clase (el patrón) y el color de fondo. */
export function chatBgPaint(p: ChatBgPref): { className: string; style: CSSProperties } {
  if (p.kind === 'none') return { className: '', style: { backgroundColor: 'var(--bg)' } };
  if (p.kind === 'plain') return { className: '', style: { backgroundColor: 'var(--chat-bg)' } };
  if (p.kind === 'color') {
    const hue = CHAT_BG_COLORS.find((c) => c.id === p.color)?.hue ?? '#25d366';
    return { className: '', style: { backgroundColor: `color-mix(in srgb, ${hue} 16%, var(--surface))` } };
  }
  return { className: 'chat-bg-pattern', style: { backgroundColor: 'var(--chat-bg)' } };
}

const mem = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
};
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? mem.get(key) ?? null;
  } catch {
    return mem.get(key) ?? null;
  }
}

/** La preferencia de la persona (o el predeterminado si no hay sesión) y cómo cambiarla. */
export function useChatBackground(): { pref: ChatBgPref; set: (p: ChatBgPref) => void; className: string; style: CSSProperties } {
  const { state } = useSession();
  const key = state.status === 'authed' ? chatBgKey(state.me.user.id, state.me.organization.id) : null;
  const raw = useSyncExternalStore(
    subscribe,
    () => (key === null ? null : readRaw(key)),
    () => null,
  );
  const pref = parseChatBg(raw);
  const set = useCallback(
    (p: ChatBgPref): void => {
      if (key === null) return;
      const text = JSON.stringify(p);
      mem.set(key, text);
      try {
        window.localStorage.setItem(key, text);
      } catch {
        /* sin almacenamiento: vale mientras la página siga abierta */
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return { pref, set, ...chatBgPaint(pref) };
}
