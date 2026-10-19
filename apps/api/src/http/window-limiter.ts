/**
 * Límite de peticiones en memoria por proceso (ventana fija): frena ráfagas y adivinanzas en las rutas públicas sin tocar la base de datos. Con varias
 * instancias el tope real es por instancia.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** `ok: true` si la petición entra; si no, cuántos segundos faltan para que se libere. Cada llamada cuenta. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    cur.n += 1;
    return cur.n <= this.limit ? { ok: true } : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
  }

  /** ¿Ya se pasó del tope? No cuenta la consulta (sirve para decidir antes de gastar trabajo). */
  blocked(key: string, now = Date.now()): { retryAfterSeconds: number } | null {
    const cur = this.hits.get(key);
    return cur && cur.resetAt > now && cur.n >= this.limit ? { retryAfterSeconds: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) } : null;
  }
}
