/**
 * `defaultFormatTranscript` — the internal `[HH:MM] Name: text` formatter
 * (DESIGN §4, §7).
 */
import { describe, expect, it } from 'vitest';

import { defaultFormatTranscript } from '../../../src/application/compaction/format-transcript.js';
import { makeMessage, T0 } from '../../conformance/support.js';

const ZONE = 'Europe/Warsaw';

describe('defaultFormatTranscript', () => {
  it('formats a text message as [HH:MM] Name: text', () => {
    const message = makeMessage({ messageId: 1, ts: T0, displayName: 'Ola', text: 'hej' });
    // T0 = 2026-09-17T09:00:00Z = 11:00 Warsaw (UTC+2 in September).
    expect(defaultFormatTranscript([message], ZONE)).toBe('[11:00] Ola: hej');
  });

  it('joins multiple messages with one line each, in the given order', () => {
    const messages = [
      makeMessage({ messageId: 1, ts: T0, displayName: 'Ola', text: 'hej' }),
      makeMessage({ messageId: 2, ts: T0.add({ minutes: 1 }), displayName: 'Marek', text: 'siema' }),
    ];
    expect(defaultFormatTranscript(messages, ZONE)).toBe('[11:00] Ola: hej\n[11:01] Marek: siema');
  });

  it('renders a media placeholder plus caption for a non-text kind', () => {
    const message = makeMessage({
      messageId: 1,
      ts: T0,
      displayName: 'Ola',
      kind: 'photo',
      text: 'from the party',
    });
    expect(defaultFormatTranscript([message], ZONE)).toBe('[11:00] Ola: [photo] from the party');
  });

  it('renders just the placeholder when a media message has no caption', () => {
    const message = makeMessage({ messageId: 1, ts: T0, displayName: 'Ola', kind: 'sticker', text: null });
    expect(defaultFormatTranscript([message], ZONE)).toBe('[11:00] Ola: [sticker]');
  });

  it('renders a gap marker with its placeholder', () => {
    const message = makeMessage({
      messageId: -1,
      ts: T0,
      displayName: null,
      userId: null,
      kind: 'gap_marker',
      text: null,
    });
    expect(defaultFormatTranscript([message], ZONE)).toBe('[11:00] (unknown): [gap in the log]');
  });

  it('an empty message list formats to an empty string', () => {
    expect(defaultFormatTranscript([], ZONE)).toBe('');
  });
});
