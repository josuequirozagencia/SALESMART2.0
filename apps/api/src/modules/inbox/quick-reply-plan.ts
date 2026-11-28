/** Largo máximo del pie de un archivo en WhatsApp. */
export const MAX_CAPTION = 1024;

export interface PlannedMessage {
  kind: 'text' | 'image' | 'video' | 'audio' | 'document';
  body: string | null;
  fileId: string | null;
}

/**
 * En qué mensajes sale una respuesta rápida con archivos (V25, ADR-76), en orden. Lógica pura.
 *  - Sin archivos: el texto.
 *  - Texto de más de 1 024 caracteres (no cabe como pie): el texto aparte ANTES y los archivos sin pie.
 *  - Si el primer archivo es un audio (no admite pie): el audio, después el texto aparte y luego el resto.
 *  - En otro caso, el texto es el pie del primer archivo que lo admite (imagen, video o documento); los demás salen sin pie, uno por mensaje.
 */
export function planQuickReply(text: string, files: ReadonlyArray<{ id: string; kind: 'image' | 'video' | 'audio' | 'document' }>): PlannedMessage[] {
  const asText: PlannedMessage = { kind: 'text', body: text, fileId: null };
  const asFile = (f: (typeof files)[number], body: string | null = null): PlannedMessage => ({ kind: f.kind, body, fileId: f.id });
  if (files.length === 0) return text === '' ? [] : [asText];
  if (text === '') return files.map((f) => asFile(f));
  if (text.length > MAX_CAPTION) return [asText, ...files.map((f) => asFile(f))];
  if (files[0]!.kind === 'audio') return [asFile(files[0]!), asText, ...files.slice(1).map((f) => asFile(f))];
  return files.map((f, i) => asFile(f, i === 0 ? text : null));
}
