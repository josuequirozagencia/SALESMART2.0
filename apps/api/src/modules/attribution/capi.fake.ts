import { CapiSendError, type CapiEvent, type CapiProvider } from './capi.ports';

/** Fake de Conversions API para pruebas: guarda lo enviado y permite simular fallos. Debe pasar el mismo contract test que el adaptador real. */
export class FakeCapiProvider implements CapiProvider {
  readonly kind = 'fake' as const;
  readonly sent: CapiEvent[] = [];
  private failures: CapiSendError[] = [];

  /** El próximo envío falla con este error (los siguientes funcionan). */
  failNext(error: CapiSendError): void {
    this.failures.push(error);
  }

  last(): CapiEvent | undefined {
    return this.sent[this.sent.length - 1];
  }

  send(event: CapiEvent): Promise<void> {
    const fail = this.failures.shift();
    if (fail) return Promise.reject(fail);
    this.sent.push(event);
    return Promise.resolve();
  }
}
