import type { CaptchaVerifier } from './ports';

export interface TurnstileOptions {
  secret: string;
  /** Solo pruebas: sustituye a `fetch` global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

/**
 * Verificación de Cloudflare Turnstile (ADR-37), detrás del puerto `CaptchaVerifier`.
 *  - `true` solo si Cloudflare responde `success: true` para ese token (los tokens son de un solo uso y caducan a los 5 min).
 *  - Un token inválido devuelve `false`; un fallo del proveedor (red, 5xx, tiempo) LANZA: el llamador falla cerrado y lo registra,
 *    de modo que una caída de Cloudflare es visible en los logs y no se confunde con «el usuario es un bot».
 *  - El secreto nunca sale en mensajes de error.
 */
export class TurnstileVerifier implements CaptchaVerifier {
  readonly available = true;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(private readonly opts: TurnstileOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.url = opts.url ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  }

  async verify(input: { token: string; ip?: string }): Promise<boolean> {
    if (!input.token || input.token.length > 2048) return false; // formato imposible: ni se consulta al proveedor
    const body = new URLSearchParams({ secret: this.opts.secret, response: input.token });
    if (input.ip) body.set('remoteip', input.ip);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { method: 'POST', body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new Error(e instanceof Error && e.name === 'TimeoutError' ? 'Turnstile: tiempo de espera agotado' : 'Turnstile: no se pudo conectar', { cause: e });
    }
    if (!res.ok) throw new Error(`Turnstile respondió ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { success?: unknown };
    return j.success === true;
  }
}
