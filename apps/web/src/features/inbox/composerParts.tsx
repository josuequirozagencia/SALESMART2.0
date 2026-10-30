import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Botón de ícono del redactor: nombre accesible y tooltip por `label`, y área táctil de al menos 44 px (M5.8). */
export function IconButton({ label, onClick, disabled, pressed, danger, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
      className={`grid size-11 shrink-0 place-items-center rounded-full border text-muted hover:text-fg disabled:opacity-50 ${danger ? 'border-crit bg-crit-soft text-crit' : pressed ? 'border-accent bg-accent-soft text-accent' : 'border-line'}`}
    >
      {children}
    </button>
  );
}

const svg = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
export const ClipIcon = () => <svg {...svg}><path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>;
export const MicIcon = () => <svg {...svg}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>;
export const SmileIcon = () => <svg {...svg}><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>;
export const StopIcon = () => <svg {...svg}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
export const XIcon = () => <svg {...svg}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const ClockIcon = () => <svg {...svg}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>;

export const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** El tiempo de grabación máximo: WhatsApp acepta audios de hasta 16 MB; a este ritmo sobra. */
export const MAX_RECORD_SECONDS = 300;

export interface Recorder {
  recording: boolean;
  seconds: number;
  error: string | undefined;
  start: () => Promise<void>;
  /** Termina y entrega el archivo grabado. */
  stop: () => void;
  /** Termina y descarta lo grabado. */
  cancel: () => void;
}

/**
 * Grabación de notas de voz desde el micrófono (M5.8): cuenta los segundos, se corta sola a los 5 minutos y entrega un archivo a `onFile`. Al cancelar o salir de la pantalla el
 * micrófono se libera siempre (si no, el navegador seguiría mostrando que graba).
 */
export function useVoiceRecorder(onFile: (f: File) => void): Recorder {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string>();
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const discard = useRef(false);
  const cb = useRef(onFile);
  useEffect(() => { cb.current = onFile; });

  const release = (): void => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    setRecording(false);
  };
  const stop = (): void => { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); };
  const cancel = (): void => { discard.current = true; stop(); if (!rec.current) release(); };

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= MAX_RECORD_SECONDS) stop();
  });
  useEffect(() => () => { discard.current = true; if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); stream.current?.getTracks().forEach((t) => t.stop()); }, []);

  const start = async (): Promise<void> => {
    setError(undefined);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Este navegador no permite grabar audio.'); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const r = new MediaRecorder(s, { mimeType });
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.current.push(ev.data); };
      r.onstop = () => {
        const keep = !discard.current && chunks.current.length > 0;
        const blob = new Blob(chunks.current, { type: r.mimeType });
        release();
        if (keep) cb.current(new File([blob], 'grabacion.webm', { type: blob.type }));
      };
      stream.current = s;
      rec.current = r;
      setSeconds(0);
      r.start();
      setRecording(true);
    } catch {
      setError('No pudimos acceder al micrófono. Revisa los permisos del navegador.');
    }
  };

  return { recording, seconds, error, start, stop, cancel };
}
