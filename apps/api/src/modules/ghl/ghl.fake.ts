import { GhlError, type GhlContactInput, type GhlCredentials, type GhlProvider } from './ghl.ports';

/** Lo que el fake «hizo» en GHL, en orden (las pruebas lo leen). */
export type FakeGhlCall =
  | { kind: 'addTags'; contactId: string; tags: string[]; credentials: GhlCredentials }
  | { kind: 'removeTags'; contactId: string; tags: string[]; credentials: GhlCredentials }
  | { kind: 'upsertContact'; input: GhlContactInput; credentials: GhlCredentials }
  | { kind: 'deleteTag'; name: string; credentials: GhlCredentials };

/** Fake de GoHighLevel para pruebas: guarda con qué credenciales se llamó y permite simular fallos. Debe pasar el mismo contract test que el adaptador real. */
export class FakeGhlProvider implements GhlProvider {
  readonly kind = 'fake' as const;
  /** Las pruebas lo activan para imitar al adaptador real, que sin credenciales de la empresa no habla con GHL. */
  requiresCredentials: boolean = false;
  readonly verified: GhlCredentials[] = [];
  /** Todo lo que se pidió a GHL (etiquetas y contactos), en orden. */
  readonly calls: FakeGhlCall[] = [];
  private verifyFailures: GhlError[] = [];
  private callFailures: GhlError[] = [];
  /** Nombre que «informa GHL» de la Location. */
  locationName: string | null = 'Barbería Norte';
  /** Identificador que «asigna GHL» a un contacto nuevo (se numera para distinguirlos). */
  private nextContact = 1;
  /** Etiquetas que «existen en GHL» (en minúsculas): `deleteTag` devuelve si estaba. */
  readonly existingTags = new Set<string>();
  /** Contactos «ya existentes en GHL» por teléfono, para probar el emparejamiento. */
  readonly existingByPhone = new Map<string, string>();

  /** La próxima comprobación falla con este error. */
  failNextVerify(error: GhlError): void {
    this.verifyFailures.push(error);
  }

  /** La próxima llamada de etiquetas o de contacto falla con este error (las siguientes funcionan). */
  failNextCall(error: GhlError): void {
    this.callFailures.push(error);
  }

  verify(credentials: GhlCredentials): Promise<{ name: string | null }> {
    const fail = this.verifyFailures.shift();
    if (fail) return Promise.reject(fail);
    this.verified.push(credentials);
    return Promise.resolve({ name: this.locationName });
  }

  addTags(credentials: GhlCredentials, contactId: string, tags: readonly string[]): Promise<void> {
    const fail = this.callFailures.shift();
    if (fail) return Promise.reject(fail);
    this.calls.push({ kind: 'addTags', contactId, tags: [...tags], credentials });
    return Promise.resolve();
  }

  removeTags(credentials: GhlCredentials, contactId: string, tags: readonly string[]): Promise<void> {
    const fail = this.callFailures.shift();
    if (fail) return Promise.reject(fail);
    this.calls.push({ kind: 'removeTags', contactId, tags: [...tags], credentials });
    return Promise.resolve();
  }

  upsertContact(credentials: GhlCredentials, input: GhlContactInput): Promise<{ id: string; created: boolean }> {
    const fail = this.callFailures.shift();
    if (fail) return Promise.reject(fail);
    this.calls.push({ kind: 'upsertContact', input, credentials });
    const known = input.phone ? this.existingByPhone.get(input.phone) : undefined;
    if (known) return Promise.resolve({ id: known, created: false });
    const id = `FakeGhlContact${String(this.nextContact++).padStart(6, '0')}`;
    if (input.phone) this.existingByPhone.set(input.phone, id);
    return Promise.resolve({ id, created: true });
  }

  deleteTag(credentials: GhlCredentials, name: string): Promise<{ deleted: boolean }> {
    const fail = this.callFailures.shift();
    if (fail) return Promise.reject(fail);
    this.calls.push({ kind: 'deleteTag', name, credentials });
    return Promise.resolve({ deleted: this.existingTags.delete(name.toLowerCase()) });
  }
}
