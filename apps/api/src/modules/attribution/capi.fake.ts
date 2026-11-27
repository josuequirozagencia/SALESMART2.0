import { CapiSendError, type AdNames, type CapiCredentials, type CapiEvent, type CapiProvider } from './capi.ports';

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

  /** Anuncios que «conoce Meta» en las pruebas (id → nombres). Los demás salen como no encontrados. */
  readonly ads = new Map<string, AdNames>();
  readonly lookups: string[][] = [];
  private lookupFailures: CapiSendError[] = [];

  failNextLookup(error: CapiSendError): void {
    this.lookupFailures.push(error);
  }

  lookupAds(adIds: readonly string[], _credentials: CapiCredentials): Promise<Record<string, AdNames | null>> {
    const fail = this.lookupFailures.shift();
    if (fail) return Promise.reject(fail);
    this.lookups.push([...adIds]);
    return Promise.resolve(Object.fromEntries(adIds.map((id) => [id, this.ads.get(id) ?? null])));
  }

  /** Dataset de mensajes que «devuelve Meta» por cuenta de WhatsApp (las pruebas lo cargan; si no, uno fijo). */
  readonly messagingDatasets = new Map<string, string>();
  readonly ensured: Array<{ wabaId: string; credentials: CapiCredentials }> = [];
  private ensureFailures: CapiSendError[] = [];

  failNextEnsure(error: CapiSendError): void {
    this.ensureFailures.push(error);
  }

  ensureMessagingDataset(wabaId: string, credentials: CapiCredentials): Promise<{ datasetId: string }> {
    const fail = this.ensureFailures.shift();
    if (fail) return Promise.reject(fail);
    this.ensured.push({ wabaId, credentials });
    return Promise.resolve({ datasetId: this.messagingDatasets.get(wabaId) ?? '1030123066792188' });
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
