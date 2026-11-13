import { describe, expect, it } from 'vitest';
import { pickRecordingType, recordingFilename } from '../src/features/inbox/composerParts';

// v13 S0.2: el formato de la nota de voz se negocia con el navegador; iOS Safari no sabe WebM y antes fallaba al pedirlo.
describe('formato de la nota de voz', () => {
  it('Chrome y Edge (WebM/Opus): prefiere WebM con Opus', () => {
    expect(pickRecordingType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
  });
  it('Firefox (OGG/Opus y WebM): prefiere WebM con Opus, y sin él OGG/Opus', () => {
    expect(pickRecordingType((t) => t === 'audio/ogg;codecs=opus' || t === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(pickRecordingType((t) => t === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
  });
  it('iOS Safari (solo MP4/AAC): usa audio/mp4 en lugar de fallar pidiendo WebM', () => {
    expect(pickRecordingType((t) => t === 'audio/mp4')).toBe('audio/mp4');
  });
  it('si el navegador no confirma ninguno, no se fuerza ninguno (que elija el navegador)', () => {
    expect(pickRecordingType(() => false)).toBeUndefined();
  });
  it('el nombre del archivo lleva la extensión del tipo realmente grabado', () => {
    expect(recordingFilename('audio/mp4')).toBe('grabacion.m4a');
    expect(recordingFilename('audio/mp4;codecs=mp4a.40.2')).toBe('grabacion.m4a');
    expect(recordingFilename('audio/ogg;codecs=opus')).toBe('grabacion.ogg');
    expect(recordingFilename('audio/webm;codecs=opus')).toBe('grabacion.webm');
    expect(recordingFilename('audio/aac')).toBe('grabacion.aac');
    expect(recordingFilename('')).toBe('grabacion.webm');
  });
});
