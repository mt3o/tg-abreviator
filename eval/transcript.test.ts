import { describe, expect, it } from 'vitest';

import { buildTranscript } from './transcript.js';
import type { FixtureLine } from './types.js';

describe('buildTranscript', () => {
  it('renders a message line as [HH:MM] Name: text', () => {
    const lines: FixtureLine[] = [
      { kind: 'message', message: { speaker: 'Ola', time: '09:00', text: 'hej' } },
    ];
    expect(buildTranscript(lines)).toBe('[09:00] Ola: hej');
  });

  it('renders a gap line with its note, distinct from a message line', () => {
    const lines: FixtureLine[] = [{ kind: 'gap', note: 'no messages logged for 3 hours' }];
    expect(buildTranscript(lines)).toBe('--- gap: no messages logged for 3 hours ---');
  });

  it('joins multiple lines with newlines, in order', () => {
    const lines: FixtureLine[] = [
      { kind: 'message', message: { speaker: 'Ola', time: '09:00', text: 'a' } },
      { kind: 'gap', note: 'missing 09:05-09:10' },
      { kind: 'message', message: { speaker: 'Marek', time: '09:10', text: 'b' } },
    ];
    expect(buildTranscript(lines)).toBe(
      ['[09:00] Ola: a', '--- gap: missing 09:05-09:10 ---', '[09:10] Marek: b'].join('\n'),
    );
  });

  it('returns an empty string for no lines', () => {
    expect(buildTranscript([])).toBe('');
  });
});
