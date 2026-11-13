import { beforeEach, describe, expect, it, vi } from 'vitest';
import { armSoundUnlock, playIncomingSound, prepareCustomSound, soundReady, testSound } from '../src/lib/notifySound';
import { resetBrand, setBrand, getBrand } from '../src/lib/platformBrand';

// Un audio simulado: cuenta lo que se toca (tono generado o archivo propio) y qué se descarga y decodifica.
const spy = vi.hoisted(() => ({ tones: 0, buffers: 0, decoded: [] as ArrayBuffer[], resumed: 0, created: 0 }));

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  constructor() {
    spy.created++;
  }
  resume(): Promise<void> {
    spy.resumed++;
    return Promise.resolve();
  }
  createGain() {
    return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
  createOscillator() {
    spy.tones++;
    return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
  }
  createBufferSource() {
    return { buffer: null as unknown, connect() {}, start: () => { spy.buffers++; } };
  }
  decodeAudioData(data: ArrayBuffer): Promise<{ id: number }> {
    spy.decoded.push(data);
    return Promise.resolve({ id: spy.decoded.length });
  }
}

const brandWith = (sound: string | null): void => setBrand({ ...getBrand(), sound });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const okFetch = (): ReturnType<typeof vi.fn> => vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));

beforeEach(() => {
  vi.unstubAllGlobals();
  spy.tones = 0;
  spy.buffers = 0;
  spy.decoded.length = 0;
  spy.resumed = 0;
  resetBrand();
  prepareCustomSound(); // sin sonido propio: borra lo que hubiera de una prueba anterior
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

describe('sonido de mensaje nuevo con el archivo de la marca', () => {
  it('«Probar» sin archivo propio toca el tono generado y no descarga nada', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    expect(await testSound(null)).toBe('ok');
    expect(spy.tones).toBe(2);
    expect(spy.buffers).toBe(0);
    expect(f).not.toHaveBeenCalled();
    expect(soundReady()).toBe(true); // el clic dejó el audio habilitado
  });

  it('«Probar» con archivo propio lo descarga con la misma sesión, lo decodifica y lo toca; un fallo no lanza', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    expect(await testSound('/v1/branding/sound?v=s1')).toBe('ok');
    expect(f).toHaveBeenCalledWith('/v1/branding/sound?v=s1', { credentials: 'same-origin' });
    expect(spy.decoded).toHaveLength(1);
    expect(spy.buffers).toBe(1);
    expect(spy.tones).toBe(0);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    expect(await testSound('/v1/branding/sound?v=s2')).toBe('error');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('sin red'))));
    expect(await testSound('/v1/branding/sound?v=s3')).toBe('error');
    expect(spy.buffers).toBe(1);
  });

  it('con un sonido propio en la marca, el mensaje nuevo toca ese archivo (y lo prepara una sola vez); si la marca lo quita, vuelve al tono', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    armSoundUnlock();
    await testSound(null); // habilita el audio
    spy.tones = 0;
    brandWith('/v1/branding/sound?v=s1'); // el Súper Admin subió un sonido: se prepara solo
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(playIncomingSound()).toBe(true);
    expect(spy.buffers).toBe(1);
    expect(spy.tones).toBe(0);
    expect(playIncomingSound()).toBe(true);
    expect(spy.buffers).toBe(2);
    expect(f).toHaveBeenCalledTimes(1); // no se vuelve a descargar
    brandWith(null);
    await flush();
    expect(playIncomingSound()).toBe(true);
    expect(spy.tones).toBe(2); // otra vez el tono generado
    expect(spy.buffers).toBe(2);
  });

  it('mientras el sonido propio no termina de cargar, o si no se puede cargar, suena el tono: nunca queda en silencio', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('sin red'))));
    armSoundUnlock();
    await testSound(null);
    spy.tones = 0;
    brandWith('/v1/branding/sound?v=roto');
    await flush();
    expect(playIncomingSound()).toBe(true);
    expect(spy.tones).toBe(2);
    expect(spy.buffers).toBe(0);
  });

  it('si el sonido cambia mientras se descarga el anterior, no se toca el viejo', async () => {
    let resolveOld: (v: unknown) => void = () => undefined;
    const f = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockImplementation(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }));
    vi.stubGlobal('fetch', f);
    armSoundUnlock();
    await testSound(null);
    spy.tones = 0;
    brandWith('/v1/branding/sound?v=viejo');
    await flush();
    brandWith('/v1/branding/sound?v=nuevo');
    await flush();
    resolveOld({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)) });
    await flush();
    expect(playIncomingSound()).toBe(true);
    expect(spy.buffers).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
