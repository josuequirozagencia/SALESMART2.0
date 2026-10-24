import { GhlError, type GhlCredentials, type GhlProvider } from './ghl.ports';

/** Fake de GoHighLevel para pruebas: guarda con qué credenciales se llamó y permite simular fallos. Debe pasar el mismo contract test que el adaptador real. */
export class FakeGhlProvider implements GhlProvider {
  readonly kind = 'fake' as const;
  /** Las pruebas lo activan para imitar al adaptador real, que sin credenciales de la empresa no habla con GHL. */
  requiresCredentials: boolean = false;
  readonly verified: GhlCredentials[] = [];
  private verifyFailures: GhlError[] = [];
  /** Nombre que «informa GHL» de la Location. */
  locationName: string | null = 'Barbería Norte';

  /** La próxima comprobación falla con este error. */
  failNextVerify(error: GhlError): void {
    this.verifyFailures.push(error);
  }

  verify(credentials: GhlCredentials): Promise<{ name: string | null }> {
    const fail = this.verifyFailures.shift();
    if (fail) return Promise.reject(fail);
    this.verified.push(credentials);
    return Promise.resolve({ name: this.locationName });
  }
}
