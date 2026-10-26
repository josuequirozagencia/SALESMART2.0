import { AiProviderError, type AiCredentials, type AIProvider, type ChatRequest, type ChatResult, type EmbedRequest, type EmbedResult } from './ai.ports';

/** Lo que el fake «hizo», en orden (las pruebas lo leen). Sin la clave: nunca se guarda. */
export type FakeAiCall = { kind: 'embed'; model: string; inputs: string[]; dimensions: number } | { kind: 'chat'; request: ChatRequest };

const WORD = /[\p{L}\p{N}]{2,}/gu;
/** Palabras vacías del español: no dicen de qué trata un texto, así que el vector falso las ignora (como haría un modelo de verdad). */
const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'unos', 'unas', 'y', 'o', 'al', 'en', 'es', 'con', 'por', 'para', 'que', 'se', 'su', 'sus', 'lo', 'le', 'cual', 'como', 'mas', 'muy', 'si', 'no', 'te', 'me', 'mi', 'tu', 'nos', 'son', 'hay', 'ya', 'sin', 'sobre']);
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Hash FNV-1a de 32 bits (suficiente para repartir palabras en las dimensiones del vector falso). */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Vector falso pero DETERMINISTA: cada palabra (sin acentos ni mayúsculas) suma o resta en una dimensión según su hash. Dos textos que comparten palabras quedan cerca y dos que no, lejos: así las
 * pruebas de búsqueda se comportan como una búsqueda semántica sencilla, sin red ni clave. No es un modelo: solo sirve para probar la lógica que lo rodea.
 */
export function fakeVector(text: string, dimensions: number): number[] {
  const v = new Array<number>(dimensions).fill(0);
  for (const w of fold(text).match(WORD) ?? []) {
    if (STOP.has(w)) continue;
    const h = fnv(w);
    v[h % dimensions]! += h & 0x80000000 ? -1 : 1;
  }
  return v;
}

/** Fake de IA para pruebas: guarda con qué se la llamó (sin la clave), permite simular fallos y responde de forma predecible. Debe pasar el mismo contract test que el adaptador real. */
export class FakeAiProvider implements AIProvider {
  readonly kind = 'fake' as const;
  /** Las pruebas lo activan para imitar al adaptador real, que sin la clave de la plataforma no habla con el proveedor. */
  requiresCredentials = false;
  readonly calls: FakeAiCall[] = [];
  /** Con qué claves se llamó (para comprobar que se usa la de la plataforma); nunca se compara con datos de empresas. */
  readonly keysSeen: string[] = [];
  private failures: AiProviderError[] = [];
  /** Lo que responde `chat` (las pruebas lo cambian). */
  chatReply: (request: ChatRequest) => string = () => 'Respuesta de prueba';
  /** Si es verdadero, `embed` cuenta un token por cada 4 caracteres; si no, exactamente `tokensPerInput` por texto. */
  tokensPerInput: number | null = null;

  /** La próxima llamada (de cualquier tipo) falla con este error. */
  failNext(error: AiProviderError): void {
    this.failures.push(error);
  }

  embed(credentials: AiCredentials, request: EmbedRequest): Promise<EmbedResult> {
    const fail = this.failures.shift();
    if (fail) return Promise.reject(fail);
    this.keysSeen.push(credentials.apiKey);
    this.calls.push({ kind: 'embed', model: request.model, inputs: [...request.inputs], dimensions: request.dimensions });
    if (request.inputs.length === 0) return Promise.reject(new AiProviderError('No hay textos que vectorizar', false));
    const tokens = request.inputs.reduce((n, s) => n + (this.tokensPerInput ?? Math.ceil(s.length / 4)), 0);
    return Promise.resolve({ vectors: request.inputs.map((s) => fakeVector(s, request.dimensions)), tokens });
  }

  chat(credentials: AiCredentials, request: ChatRequest): Promise<ChatResult> {
    const fail = this.failures.shift();
    if (fail) return Promise.reject(fail);
    this.keysSeen.push(credentials.apiKey);
    this.calls.push({ kind: 'chat', request });
    const text = this.chatReply(request);
    return Promise.resolve({ text, tokensIn: Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4), tokensOut: Math.ceil(text.length / 4) });
  }
}
