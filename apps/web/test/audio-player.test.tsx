import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer, clock } from '../src/features/inbox/AudioPlayer';

beforeEach(() => {
  // jsdom no reproduce audio: se simulan play/pause para que el reproductor reaccione a sus eventos
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => vi.restoreAllMocks());

const audioEl = (): HTMLAudioElement => document.querySelector('audio')!;
const setDuration = (el: HTMLAudioElement, d: number): void => {
  Object.defineProperty(el, 'duration', { configurable: true, value: d });
  act(() => { el.dispatchEvent(new Event('durationchange')); });
};

describe('Reproductor de audio', () => {
  it('formatea los segundos como m:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(5.9)).toBe('0:05');
    expect(clock(100)).toBe('1:40');
    expect(clock(Number.NaN)).toBe('0:00');
  });

  it('muestra la duración quieto, los segundos corriendo al reproducir y deja pausar', async () => {
    render(<AudioPlayer id="a1" url="https://storage.test/a1?sig=1" />);
    setDuration(audioEl(), 100);
    expect(screen.getByText('1:40')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reproducir el audio' }));
    expect(await screen.findByRole('button', { name: 'Pausar el audio' })).toBeInTheDocument();
    act(() => { Object.defineProperty(audioEl(), 'currentTime', { configurable: true, writable: true, value: 5 }); audioEl().dispatchEvent(new Event('timeupdate')); });
    expect(screen.getByText('0:05')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Posición del audio' })).toHaveAttribute('aria-valuetext', '0:05 de 1:40');
    await userEvent.click(screen.getByRole('button', { name: 'Pausar el audio' }));
    expect(screen.getByRole('button', { name: 'Reproducir el audio' })).toBeInTheDocument();
  });

  it('la velocidad pasa de 1× a 1,5× y a 2×', async () => {
    render(<AudioPlayer id="a2" url="https://storage.test/a2" />);
    setDuration(audioEl(), 30);
    await userEvent.click(screen.getByRole('button', { name: 'Reproducir el audio' }));
    const speed = await screen.findByRole('button', { name: /Velocidad 1 veces/ });
    await userEvent.click(speed);
    expect(audioEl().playbackRate).toBe(1.5);
    await userEvent.click(screen.getByRole('button', { name: /Velocidad 1.5 veces/ }));
    expect(audioEl().playbackRate).toBe(2);
  });

  it('si el hilo se vuelve a pedir y la dirección firmada cambia, el audio NO se recarga (no se corta)', () => {
    const { rerender } = render(<AudioPlayer id="a3" url="https://storage.test/a3?sig=1" />);
    const before = audioEl().getAttribute('src');
    rerender(<AudioPlayer id="a3" url="https://storage.test/a3?sig=2" />);
    expect(audioEl().getAttribute('src')).toBe(before);
    // otro audio sí toma su dirección
    rerender(<AudioPlayer id="a4" url="https://storage.test/a4?sig=9" />);
    expect(audioEl().getAttribute('src')).toBe('https://storage.test/a4?sig=9');
  });

  it('si el archivo falla, primero prueba la dirección nueva y luego ofrece descargarlo', () => {
    const { rerender } = render(<AudioPlayer id="a5" url="https://storage.test/a5?sig=1" filename="nota.ogg" />);
    rerender(<AudioPlayer id="a5" url="https://storage.test/a5?sig=2" filename="nota.ogg" />);
    fireEvent.error(audioEl());
    expect(audioEl().getAttribute('src')).toBe('https://storage.test/a5?sig=2'); // venció: usa la nueva
    fireEvent.error(audioEl());
    expect(screen.getByText(/No se pudo reproducir este audio/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Descargar' })).toHaveAttribute('download', 'nota.ogg');
  });
});
