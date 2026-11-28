import { describe, expect, it } from 'vitest';
import { planQuickReply } from '../../src/modules/inbox/quick-reply-plan';

const img = { id: 'i', kind: 'image' as const };
const doc = { id: 'd', kind: 'document' as const };
const aud = { id: 'a', kind: 'audio' as const };
const shape = (text: string, files: Array<typeof img | typeof doc | typeof aud>) => planQuickReply(text, files).map((p) => [p.kind, p.body === null ? null : p.body.length > 20 ? 'largo' : p.body, p.fileId]);

describe('en qué mensajes sale una respuesta rápida con archivos', () => {
  it('sin archivos, el texto; sin nada, nada', () => {
    expect(shape('hola', [])).toEqual([['text', 'hola', null]]);
    expect(shape('', [])).toEqual([]);
  });
  it('el texto es el pie del primer archivo; los demás sin pie', () => {
    expect(shape('hola', [img, doc])).toEqual([['image', 'hola', 'i'], ['document', null, 'd']]);
    expect(shape('', [img, doc])).toEqual([['image', null, 'i'], ['document', null, 'd']]);
  });
  it('audio primero: audio, texto aparte y el resto', () => {
    expect(shape('hola', [aud, img])).toEqual([['audio', null, 'a'], ['text', 'hola', null], ['image', null, 'i']]);
    expect(shape('hola', [img, aud])).toEqual([['image', 'hola', 'i'], ['audio', null, 'a']]);
  });
  it('un texto que no cabe como pie va aparte y antes', () => {
    expect(shape('x'.repeat(1025), [img])).toEqual([['text', 'largo', null], ['image', null, 'i']]);
    expect(shape('x'.repeat(1024), [img])).toEqual([['image', 'largo', 'i']]);
  });
});
