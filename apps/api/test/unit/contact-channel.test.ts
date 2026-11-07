import { describe, expect, it } from 'vitest';
import { CONTACT_CHANNELS } from '@sales-smart/shared';
import { channelOf, channelOfForm, contactChannelSchema } from '../../src/modules/contacts/contact-channel';

describe('canal del lead (M3.3 §11): derivación según la fuente', () => {
  it('CTWA con placement instagram → instagram; con placement facebook o sin placement → facebook', () => {
    expect(channelOf('meta_ctwa', 'instagram')).toBe('instagram');
    expect(channelOf('meta_ctwa', 'facebook')).toBe('facebook');
    expect(channelOf('meta_ctwa')).toBe('facebook');
    expect(channelOf('meta_ctwa', null)).toBe('facebook');
  });
  it('mensaje de WhatsApp sin anuncio → whatsapp; creación manual → manual; cualquier otro origen → other', () => {
    expect(channelOf('whatsapp')).toBe('whatsapp');
    expect(channelOf('manual')).toBe('manual');
    for (const s of ['ghl', 'import', 'form', 'otra_cosa']) expect(channelOf(s), s).toBe('other');
    // el placement solo cuenta para un clic de anuncio de Meta
    expect(channelOf('whatsapp', 'instagram')).toBe('whatsapp');
  });
  it('formulario público: se deriva del utm_source; sin nada reconocible, other', () => {
    for (const v of ['facebook', 'FB', ' Meta ']) expect(channelOfForm({ utm_source: v }), v).toBe('facebook');
    for (const v of ['instagram', 'IG']) expect(channelOfForm({ utm_source: v }), v).toBe('instagram');
    for (const v of ['google', 'tiktok', '', 'x'.repeat(50)]) expect(channelOfForm({ utm_source: v }), v).toBe('other');
    expect(channelOfForm({})).toBe('other');
    expect(channelOfForm(undefined)).toBe('other');
  });
  it('el esquema acepta exactamente los canales permitidos', () => {
    for (const c of CONTACT_CHANNELS) expect(contactChannelSchema.safeParse(c).success, c).toBe(true);
    for (const bad of ['tiktok', 'Facebook', '', null, 1]) expect(contactChannelSchema.safeParse(bad).success, String(bad)).toBe(false);
    expect([...CONTACT_CHANNELS]).toEqual(['facebook', 'instagram', 'whatsapp', 'manual', 'other']);
  });
});
