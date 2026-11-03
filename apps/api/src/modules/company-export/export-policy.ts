/**
 * Qué entra y qué NO entra al paquete «Descargar todo» (F3b, ADR-59 #8). Las tablas y columnas se descubren del catálogo de PostgreSQL (no de una lista escrita a mano, que se desfasaría con cada migración);
 * lo único escrito aquí es la regla de exclusión y las excepciones, y una prueba recorre el catálogo entero para que una columna sensible nueva no llegue al paquete sin que alguien lo decida.
 */

/** Columnas que guardan un secreto, una credencial, una huella o un dato binario sin valor para una persona. */
export const SENSITIVE_COLUMN = /(sealed|_enc$|key_version|secret|password|hash|fingerprint|credential|private|embedding|signature|nonce|api_?key|token)/i;

/**
 * Columnas cuyo nombre se parece a uno sensible pero que no lo son: conteos de uso de la IA y los últimos 4 caracteres de una credencial (lo único que la aplicación ya le muestra al cliente).
 * Cualquier columna nueva con un nombre «sensible» queda EXCLUIDA hasta que alguien la añada aquí a propósito.
 */
export const SAFE_LOOKALIKES: ReadonlySet<string> = new Set(['tokens', 'tokens_in', 'tokens_out', 'max_tokens', 'token_last4']);

/** ¿Esta columna se queda fuera del paquete? Los binarios (vectores de búsqueda, etc.) también: no sirven en un JSON y se regeneran. */
export function isExcludedColumn(name: string, typeName: string): boolean {
  if (typeName === 'bytea') return true;
  return SENSITIVE_COLUMN.test(name) && !SAFE_LOOKALIKES.has(name);
}

/** Lo que una persona abre en una hoja de cálculo: tabla → nombre del CSV. El resto de las tablas va solo en `datos/` como JSON por línea. */
export const CSV_TABLES: ReadonlyArray<{ table: string; file: string }> = [
  { table: 'contacts', file: 'contactos' },
  { table: 'contact_phones', file: 'telefonos_de_contactos' },
  { table: 'conversations', file: 'conversaciones' },
  { table: 'opportunities', file: 'oportunidades' },
  { table: 'sales', file: 'ventas' },
  { table: 'sale_payments', file: 'abonos' },
  { table: 'appointments', file: 'citas' },
  { table: 'tasks', file: 'tareas' },
];

/** Tablas cuyos archivos del almacenamiento van en `archivos/`. */
export const FILE_TABLES = ['message_attachments', 'knowledge_documents'] as const;

/** Un nombre seguro para una entrada de ZIP: sin rutas, sin caracteres de control y de largo acotado. */
export function safeEntryName(name: string, fallback: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = [...last].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || '"<>:|?*'.includes(ch) ? '_' : ch)).join('');
  const base = cleaned.replace(/^\.+/, '').trim();
  return (base.length > 0 ? base : fallback).slice(0, 120);
}

/** Texto del correo/archivo con el tamaño en unidades legibles. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
