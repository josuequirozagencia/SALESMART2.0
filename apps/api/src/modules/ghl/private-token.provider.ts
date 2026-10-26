import { GhlError, type GhlContactInput, type GhlCredentials, type GhlOutgoingMessage, type GhlProvider } from './ghl.ports';

/**
 * Valor de la cabecera `Version` de la API 2.0 de GHL. SIN CONFIRMAR contra una cuenta real: la documentación oficial de versionado lista `2021-07-28`, pero otras fuentes (y algunas
 * páginas del propio sitio) mencionan `2023-02-21` o `v3` según el endpoint, y es lo primero que se valida con la subcuenta del responsable (docs/M7_PLAN.md §5). Es el único lugar donde vive.
 */
export const GHL_API_VERSION = '2021-07-28';
const DEFAULT_BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = /^[A-Za-z0-9]{8,64}$/;
/** Identificador de un contacto de GHL: solo letras y números (se arma una dirección con él, así que no se acepta nada más). */
const CONTACT_ID = /^[A-Za-z0-9]{6,64}$/;
/** Identificador de una etiqueta de GHL: solo letras y números (también se arma una dirección con él). */
const TAG_ID = /^[A-Za-z0-9]{6,64}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Etiquetas por llamada (y largo de cada una): lo que se manda a GHL está acotado. */
export const MAX_TAGS_PER_CALL = 50;
const MAX_TAG_LENGTH = 100;
/** Lo que se manda por mensaje: el mismo tope que admite la base. */
const MAX_MESSAGE_LENGTH = 8000;
const REPLY_TYPES: ReadonlySet<string> = new Set(['SMS', 'WhatsApp', 'IG', 'FB', 'Live_Chat']);

/** Texto de GHL apto para mostrarse: sin saltos de línea, acotado y sin nada parecido a un token (`pit-<uuid>`), un correo o un teléfono. */
const safeText = (v: unknown): string =>
  String(Array.isArray(v) ? v.join('; ') : typeof v === 'string' ? v : '')
    .replace(/pit-[0-9a-f-]{20,}/gi, '[token]')
    // GHL a veces repite en su mensaje el dato que rechazó: ni teléfonos ni correos llegan a nuestros registros
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, '[correo]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[número]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    return safeText(body.message ?? body.error);
  } catch {
    return '';
  }
}

/**
 * Adaptador de GoHighLevel con Private Integration Token (M7, ADR-05/ADR-52). Habla solo con la API de GHL: el token va en la cabecera `Authorization` (nunca en la dirección), sin
 * redirecciones, con tiempo máximo, y todo identificador se valida antes de armar la dirección. 401 y 403 son fallos de credenciales y definitivos; 429, 5xx y la red caída se reintentan.
 * El mensaje de todo error es seguro: jamás lleva el token ni datos del contacto. Probado contra un servidor simulado, NO contra GHL real.
 */
export class PrivateTokenProvider implements GhlProvider {
  readonly kind = 'ghl' as const;
  readonly requiresCredentials = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Un contacto de la Location (`limit=1`): exige el permiso de lectura de contactos, que de todos modos hace falta para todo lo demás, y falla si el token no alcanza esa Location.
   * No pide el nombre de la Location (otro permiso), así que `name` es null. Aquí un 404 es «Location inexistente o sin acceso» (credenciales).
   */
  async verify(credentials: GhlCredentials): Promise<{ name: string | null }> {
    const res = await this.call(`/contacts/?locationId=${this.location(credentials.locationId)}&limit=1`, credentials.accessToken, { method: 'GET' });
    if (!res.ok) throw await this.failure(res, true);
    return { name: null };
  }

  async addTags(credentials: GhlCredentials, ghlContactId: string, tags: readonly string[]): Promise<void> {
    const res = await this.call(`/contacts/${this.contact(ghlContactId)}/tags`, credentials.accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags: this.tagList(tags) }) });
    if (!res.ok) throw await this.failure(res, false);
  }

  async removeTags(credentials: GhlCredentials, ghlContactId: string, tags: readonly string[]): Promise<void> {
    const res = await this.call(`/contacts/${this.contact(ghlContactId)}/tags`, credentials.accessToken, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags: this.tagList(tags) }) });
    if (!res.ok) throw await this.failure(res, false);
  }

  async upsertContact(credentials: GhlCredentials, input: GhlContactInput): Promise<{ id: string; created: boolean }> {
    const body: Record<string, unknown> = { locationId: this.location(credentials.locationId) };
    if (input.name) body['name'] = input.name;
    if (input.phone) body['phone'] = input.phone;
    if (input.email) body['email'] = input.email;
    if (!input.phone && !input.email) throw new GhlError('Hace falta un teléfono o un correo para buscar o crear el contacto en GoHighLevel', false);
    const res = await this.call('/contacts/upsert', credentials.accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw await this.failure(res, false);
    try {
      const out = (await res.json()) as { contact?: { id?: unknown }; new?: unknown };
      const id = out.contact?.id;
      if (typeof id !== 'string' || !CONTACT_ID.test(id)) throw new GhlError('GoHighLevel respondió algo que no se entiende', true);
      return { id, created: out.new === true };
    } catch (e) {
      if (e instanceof GhlError) throw e;
      throw new GhlError('GoHighLevel respondió algo que no se entiende', true);
    }
  }

  /**
   * Elimina de la Location la etiqueta con ese nombre: primero la busca (`GET /locations/{id}/tags`, permiso de lectura de etiquetas) y luego la borra por su identificador
   * (`DELETE /locations/{id}/tags/{tagId}`, permiso de escritura de etiquetas). Si GHL no la tiene, no hay nada que borrar. Un 403 aquí es casi siempre un token SIN esos permisos: se informa
   * como rechazo definitivo con su motivo, sin tomarlo por un token inválido (eso lo dice el 401).
   */
  async deleteTag(credentials: GhlCredentials, name: string): Promise<{ deleted: boolean }> {
    const loc = this.location(credentials.locationId);
    const wanted = name.replace(/\p{Cc}/gu, ' ').trim().toLowerCase();
    if (wanted.length === 0) throw new GhlError('No hay etiqueta que eliminar', false);
    const list = await this.call(`/locations/${loc}/tags`, credentials.accessToken, { method: 'GET' });
    if (!list.ok) throw await this.failure(list, false, false);
    let found: string | null = null;
    try {
      const body = (await list.json()) as { tags?: Array<{ id?: unknown; name?: unknown }> };
      for (const t of Array.isArray(body.tags) ? body.tags : []) {
        if (typeof t.id === 'string' && typeof t.name === 'string' && t.name.trim().toLowerCase() === wanted) {
          found = t.id;
          break;
        }
      }
    } catch {
      throw new GhlError('GoHighLevel respondió algo que no se entiende', true);
    }
    if (found === null) return { deleted: false };
    if (!TAG_ID.test(found)) throw new GhlError('GoHighLevel respondió una etiqueta con un identificador que no se entiende', true);
    const res = await this.call(`/locations/${loc}/tags/${found}`, credentials.accessToken, { method: 'DELETE' });
    if (res.status === 404) return { deleted: false }; // otro la borró entre la búsqueda y el borrado
    if (!res.ok) throw await this.failure(res, false, false);
    return { deleted: true };
  }

  /**
   * Escribe al cliente: `POST /conversations/messages` con el canal (`type`), el contacto y el texto. Solo los canales de texto que Sales Smart reconoce. Un 404 es «el contacto ya no existe en GHL»
   * (definitivo); un 403 es un token sin permiso de conversaciones (definitivo, sin culpar al token); 401, credenciales. El texto del cliente nunca va en un mensaje de error.
   */
  async sendMessage(credentials: GhlCredentials, message: GhlOutgoingMessage): Promise<{ id: string }> {
    if (!REPLY_TYPES.has(message.type)) throw new GhlError('Ese canal de GoHighLevel no admite respuestas desde aquí', false);
    const text = message.text.trim();
    if (text.length === 0) throw new GhlError('No hay texto que enviar', false);
    if (text.length > MAX_MESSAGE_LENGTH) throw new GhlError('El mensaje es demasiado largo', false);
    const res = await this.call('/conversations/messages', credentials.accessToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: message.type, contactId: this.contact(message.ghlContactId), message: text }),
    });
    if (!res.ok) throw await this.failure(res, false, false);
    try {
      const out = (await res.json()) as { messageId?: unknown; id?: unknown };
      const id = typeof out.messageId === 'string' ? out.messageId : typeof out.id === 'string' ? out.id : null;
      if (id === null || id.length === 0 || id.length > 200) throw new GhlError('GoHighLevel respondió algo que no se entiende', true);
      return { id };
    } catch (e) {
      if (e instanceof GhlError) throw e;
      throw new GhlError('GoHighLevel respondió algo que no se entiende', true);
    }
  }

  private location(id: string): string {
    if (!LOCATION_ID.test(id)) throw new GhlError('El Location ID no es válido (solo letras y números)', false, true);
    return id;
  }

  private contact(id: string): string {
    if (!CONTACT_ID.test(id)) throw new GhlError('El identificador del contacto de GoHighLevel no es válido', false);
    return id;
  }

  private tagList(tags: readonly string[]): string[] {
    const clean = [...new Set(tags.map((t) => t.replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_TAG_LENGTH)).filter((t) => t.length > 0))].slice(0, MAX_TAGS_PER_CALL);
    if (clean.length === 0) throw new GhlError('No hay etiquetas que enviar', false);
    return clean;
  }

  private async call(path: string, token: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, version: GHL_API_VERSION, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Red caída, tiempo agotado o redirección: pasajero. El error original podría traer la dirección con datos: no se propaga.
      throw new GhlError('No se pudo contactar a GoHighLevel', true);
    }
  }

  /**
   * `forbiddenIsCredentials`: por omisión un 403 es «token sin acceso» (credenciales); en las operaciones que dependen de un permiso aparte (etiquetas de la Location) es «falta ese permiso» y no pide reconectar.
   * `notFoundIsCredentials`: en la comprobación un 404 es una Location inexistente o sin acceso (credenciales); en las llamadas sobre un contacto es «ese contacto ya no existe en
   * GHL» (definitivo, pero el token está bien).
   */
  private async failure(res: Response, notFoundIsCredentials: boolean, forbiddenIsCredentials = true): Promise<GhlError> {
    const text = await readMessage(res);
    const tail = text ? `: ${text}` : '';
    if (res.status === 403 && !forbiddenIsCredentials) return new GhlError(`El token no tiene permiso para esta operación en GoHighLevel (revisa los permisos de etiquetas de la integración)${tail}`, false);
    if (res.status === 401 || (forbiddenIsCredentials && res.status === 403) || (notFoundIsCredentials && res.status === 404)) return new GhlError(`GoHighLevel rechazó el token o no encuentra la Location${tail}`, false, true);
    if (res.status === 404) return new GhlError(`GoHighLevel no encuentra el contacto${tail}`, false);
    if (res.status === 429 || res.status >= 500) return new GhlError(`GoHighLevel no pudo atender la llamada ahora${tail}`, true);
    return new GhlError(`GoHighLevel rechazó la solicitud${tail}`, false);
  }
}
