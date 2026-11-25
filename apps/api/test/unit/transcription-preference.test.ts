// V23-A — qué modelo de transcripción se usa cuando hay varios cargados: los de OpenAI conocidos ganan a un nombre mal escrito, que ya no queda primero por orden alfabético.
import { describe, expect, it } from 'vitest';
import { byTranscriptionPreference } from '../../src/modules/platform/ai-model-prices.service';

const pick = (names: string[]): string | undefined => names.map((model) => ({ model })).sort(byTranscriptionPreference)[0]?.model;

describe('modelo de transcripción en uso', () => {
  it('un nombre inventado como «gpt-mini» no gana a whisper-1 aunque sea el primero por orden alfabético', () => {
    expect(pick(['whisper-1', 'gpt-mini'])).toBe('whisper-1');
  });
  it('respeta el orden de preferencia entre los conocidos', () => {
    expect(pick(['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'])).toBe('gpt-4o-mini-transcribe');
    expect(pick(['whisper-1', 'gpt-4o-transcribe'])).toBe('gpt-4o-transcribe');
  });
  it('sin ninguno conocido, el primero por nombre (como antes)', () => {
    expect(pick(['zeta', 'alfa'])).toBe('alfa');
    expect(pick([])).toBeUndefined();
  });
});
