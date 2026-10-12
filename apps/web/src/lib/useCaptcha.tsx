import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { captchaMode, staticCaptchaToken } from './captcha';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

/** Carga el script de Turnstile UNA vez (la CSP de la API permite solo ese origen). Si falla, la siguiente vez se reintenta. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile no inicializó')));
    s.onerror = () => { loading = null; s.remove(); reject(new Error('no se pudo cargar Turnstile')); };
    document.head.appendChild(s);
  });
  return loading;
}

type WidgetState = 'loading' | 'ready' | 'unavailable';

function TurnstileWidget({ onToken }: { onToken: (t: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<WidgetState>('loading');
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey) return;
    let id: string | undefined;
    let alive = true;
    loadTurnstile().then(
      (t) => {
        if (!alive || !box.current) return;
        id = t.render(box.current, {
          sitekey: siteKey,
          language: 'es',
          theme: 'auto',
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(null), // el token caduca a los 5 min: hay que resolver de nuevo
          'error-callback': () => onToken(null),
        });
        setState('ready');
      },
      () => { if (alive) setState('unavailable'); },
    );
    return () => {
      alive = false;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, onToken]);

  // Sin clave de sitio configurada (o sin poder cargar el script) no hay forma de resolver la verificación
  if (!siteKey || state === 'unavailable') {
    return <p role="alert" className="rounded-[10px] bg-crit-soft px-3 py-2.5 text-[13px] font-medium text-crit">No pudimos cargar la verificación anti-bots. Recarga la página o inténtalo más tarde.</p>;
  }
  return <div ref={box} data-testid="turnstile" className="min-h-[65px]" aria-label="Verificación anti-bots" />;
}

export interface Captcha {
  /** El widget (solo en modo turnstile). Se pone dentro del formulario, antes del botón de enviar. */
  widget: ReactNode;
  /**
   * Entrega el token y lo GASTA (un solo uso): en modo turnstile vuelve a generar el widget para el siguiente envío.
   * null = todavía no se resolvió la verificación.
   */
  take(): string | null;
}

export function useCaptcha(): Captcha {
  const mode = captchaMode();
  const [token, setToken] = useState<string | null>(mode === 'turnstile' ? null : staticCaptchaToken(mode));
  const [round, setRound] = useState(0);
  const onToken = useCallback((t: string | null) => setToken(t), []);

  const take = (): string | null => {
    const t = token;
    if (mode === 'turnstile') {
      setToken(null);
      setRound((r) => r + 1);
    }
    return t;
  };
  return { widget: mode === 'turnstile' ? <TurnstileWidget key={round} onToken={onToken} /> : null, take };
}

/** Texto cuando se intenta enviar sin haber resuelto la verificación. */
export const CAPTCHA_PENDING = 'Completa la verificación anti-bots para continuar.';
