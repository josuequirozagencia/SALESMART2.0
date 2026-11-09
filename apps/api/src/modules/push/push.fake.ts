import type { PushResult, PushSender, PushTarget } from './push.port';

/** Push de mentira (`PUSH_PROVIDER=fake`; se rechaza en producción): guarda lo enviado en memoria y deja decidir qué responde cada dirección. */
export class FakePushSender implements PushSender {
  readonly name = 'fake' as const;
  readonly sent: Array<{ endpoint: string; payload: string }> = [];
  /** Respuesta por dirección (por omisión `sent`). */
  readonly results = new Map<string, PushResult>();

  send(target: PushTarget, payload: string): Promise<PushResult> {
    const r = this.results.get(target.endpoint) ?? 'sent';
    if (r === 'sent') this.sent.push({ endpoint: target.endpoint, payload });
    return Promise.resolve(r);
  }

  reset(): void {
    this.sent.length = 0;
    this.results.clear();
  }
}
