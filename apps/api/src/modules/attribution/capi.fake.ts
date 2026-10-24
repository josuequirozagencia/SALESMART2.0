import { CapiSendError, type CapiCredentials, type CapiEvent, type CapiProvider } from './capi.ports';

/** Fake de Conversions API para pruebas: guarda lo enviado (y con qué credenciales) y permite simular fallos. Debe pasar el mismo contract test que el adaptador real. */
export class FakeCapiProvider implements CapiProvider {
  readonly kind = 'fake' as const;
  /** Las pruebas lo activan para imitar al adaptador real, que sin credenciales de la empresa no envía. */
  requiresCredentials: boolean = false;
  readonly sent: CapiEvent[] = [];
  /** Las credenciales con que se envió cada evento de `sent` (mismo orden). */
  readonly credentials: CapiCredentials[] = [];
  readonly verified: CapiCredentials[] = [];
  private failures: CapiSendError[] = [];
  private verifyFailures: CapiSendError[] = [];
  /** Nombre que «informa Meta» al comprobar. */
  datasetName: string | null = 'Dataset de prueba';

  /** El próximo envío falla con este error (los siguientes funcionan). */
  failNext(error: CapiSendError): void {
    this.failures.push(error);
  }

  /** La próxima comprobación falla con este error. */
  failNextVerify(error: CapiSendError): void {
    this.verifyFailures.push(error);
  }

  last(): CapiEvent | undefined {
    return this.sent[this.sent.length - 1];
  }

  send(event: CapiEvent, credentials: CapiCredentials = { datasetId: 'fake', accessToken: 'fake' }): Promise<void> {
    const fail = this.failures.shift();
    if (fail) return Promise.reject(fail);
    this.sent.push(event);
    this.credentials.push(credentials);
    return Promise.resolve();
  }

  verify(credentials: CapiCredentials): Promise<{ name: string | null }> {
    const fail = this.verifyFailures.shift();
    if (fail) return Promise.reject(fail);
    this.verified.push(credentials);
    return Promise.resolve({ name: this.datasetName });
  }
}
