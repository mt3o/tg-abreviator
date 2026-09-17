import { describe, expect, it } from 'vitest';

import { assembleCorpus } from './assemble.js';
import { Temporal } from '../time/temporal.js';
import { asChatId, asMessageId, asThreadId, asUserId } from '../model/ids.js';
import type { StoredMessage } from '../model/message.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const ZONE = 'Europe/Warsaw';

interface MsgOverrides {
  readonly messageId: number;
  readonly ts: string;
  readonly threadId?: StoredMessage['threadId'];
  readonly userId?: StoredMessage['userId'];
  readonly displayName?: StoredMessage['displayName'];
  readonly replyToMessageId?: StoredMessage['replyToMessageId'];
  readonly kind?: StoredMessage['kind'];
  readonly text?: StoredMessage['text'];
}

function field<K extends keyof MsgOverrides>(
  overrides: MsgOverrides,
  key: K,
  fallback: NonNullable<MsgOverrides[K]>,
): NonNullable<MsgOverrides[K]> {
  return Object.hasOwn(overrides, key) ? (overrides[key] as NonNullable<MsgOverrides[K]>) : fallback;
}

function msg(overrides: MsgOverrides): StoredMessage {
  return {
    chatId: CHAT_ID,
    messageId: asMessageId(overrides.messageId),
    threadId: Object.hasOwn(overrides, 'threadId') ? (overrides.threadId ?? null) : null,
    userId: Object.hasOwn(overrides, 'userId') ? (overrides.userId ?? null) : asUserId(111),
    displayName: Object.hasOwn(overrides, 'displayName') ? (overrides.displayName ?? null) : 'Ola',
    ts: Temporal.Instant.from(overrides.ts),
    replyToMessageId: Object.hasOwn(overrides, 'replyToMessageId')
      ? (overrides.replyToMessageId ?? null)
      : null,
    kind: field(overrides, 'kind', 'text'),
    text: Object.hasOwn(overrides, 'text') ? (overrides.text ?? null) : 'hello',
  };
}

describe('assembleCorpus', () => {
  it('formats a text message as [HH:MM] Name: text, in the chat zone', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:05:00Z', displayName: 'Ola', text: 'cześć' })],
      { timeZone: ZONE },
    );
    // Europe/Warsaw is UTC+2 in September (CEST).
    expect(result.transcript).toBe('[12:05] Ola: cześć');
    expect(result.messageCount).toBe(1);
    expect(result.gapCount).toBe(0);
  });

  it('is empty for an empty input', () => {
    const result = assembleCorpus([], { timeZone: ZONE });
    expect(result).toEqual({ transcript: '', messageCount: 0, gapCount: 0 });
  });

  it('renders redacted rows as a fixed placeholder, ignoring the stored text field', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', kind: 'redacted', text: 'should never leak' })],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:00] Ola: [redacted]');
    expect(result.transcript).not.toContain('should never leak');
    expect(result.messageCount).toBe(1);
  });

  it('renders a media kind as a bracketed placeholder with its caption', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', kind: 'photo', text: 'wakacje' })],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:00] Ola: [photo]: wakacje');
    expect(result.messageCount).toBe(1);
  });

  it('renders a media kind with no caption as a bare placeholder', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', kind: 'sticker', text: null })],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:00] Ola: [sticker]');
  });

  it('covers every non-text, non-redacted, non-service, non-gap-marker kind with a label', () => {
    const mediaKinds = [
      'photo',
      'video',
      'animation',
      'audio',
      'voice',
      'video_note',
      'document',
      'sticker',
      'poll',
      'location',
      'contact',
      'dice',
      'game',
    ] as const;
    for (const kind of mediaKinds) {
      const result = assembleCorpus(
        [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', kind, text: null })],
        { timeZone: ZONE },
      );
      expect(result.transcript).toMatch(/^\[12:00\] Ola: \[[^[\]]+\]$/);
    }
  });

  it('drops service rows entirely: no line, not counted as a message', () => {
    const result = assembleCorpus(
      [
        msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', kind: 'service', text: 'Ola joined the chat' }),
        msg({ messageId: 2, ts: '2026-09-17T10:01:00Z', text: 'hi' }),
      ],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:01] Ola: hi');
    expect(result.messageCount).toBe(1);
    expect(result.gapCount).toBe(0);
  });

  it('surfaces a gap marker as an explicit disclosure line, counted separately from messageCount', () => {
    const result = assembleCorpus(
      [
        msg({ messageId: 1, ts: '2026-09-17T09:00:00Z', text: 'before the gap' }),
        msg({
          messageId: -1,
          ts: '2026-09-17T10:00:00Z',
          kind: 'gap_marker',
          userId: null,
          displayName: null,
          text: null,
        }),
        msg({ messageId: 2, ts: '2026-09-17T11:00:00Z', text: 'after the gap' }),
      ],
      { timeZone: ZONE },
    );
    const lines = result.transcript.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('[12:00]');
    expect(lines[1]).toMatch(/gap/i);
    expect(lines[1]).not.toMatch(/^\[12:00\] Ola:/);
    expect(result.messageCount).toBe(2);
    expect(result.gapCount).toBe(1);
  });

  it('counts multiple gap markers independently', () => {
    const result = assembleCorpus(
      [
        msg({ messageId: -1, ts: '2026-09-17T09:00:00Z', kind: 'gap_marker', userId: null, text: null }),
        msg({ messageId: 1, ts: '2026-09-17T09:30:00Z', text: 'hi' }),
        msg({ messageId: -2, ts: '2026-09-17T10:00:00Z', kind: 'gap_marker', userId: null, text: null }),
      ],
      { timeZone: ZONE },
    );
    expect(result.gapCount).toBe(2);
    expect(result.messageCount).toBe(1);
  });

  it('falls back to a synthetic speaker name when displayName is null but userId is present', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', displayName: null, userId: asUserId(555), text: 'hej' })],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:00] user555: hej');
  });

  it('falls back to "unknown" when neither displayName nor userId is present', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', displayName: null, userId: null, text: 'hej' })],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:00] unknown: hej');
  });

  it('renders an empty text body as an empty string, not "null"', () => {
    const result = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', text: null })],
      { timeZone: ZONE },
    );
    expect(result.transcript).toBe('[12:00] Ola: ');
  });

  it('is deterministic: the same input always produces the same output', () => {
    const input = [
      msg({ messageId: 1, ts: '2026-09-17T09:00:00Z', displayName: 'Ola', text: 'siema' }),
      msg({
        messageId: -1,
        ts: '2026-09-17T09:30:00Z',
        kind: 'gap_marker',
        userId: null,
        text: null,
      }),
      msg({ messageId: 2, ts: '2026-09-17T10:00:00Z', kind: 'photo', displayName: 'Marek', text: 'plaża' }),
    ];
    const first = assembleCorpus(input, { timeZone: ZONE });
    const second = assembleCorpus(input, { timeZone: ZONE });
    expect(second).toEqual(first);
  });

  it('formats timestamps DST-correctly across a fall-back transition', () => {
    // 2026-10-25 is the last Sunday of October: Europe/Warsaw falls back
    // from CEST (UTC+2) to CET (UTC+1) at 03:00 local / 01:00 UTC.
    const before = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-10-25T00:30:00Z', text: 'still summer time' })],
      { timeZone: ZONE },
    );
    const after = assembleCorpus(
      [msg({ messageId: 1, ts: '2026-10-25T01:30:00Z', text: 'now winter time' })],
      { timeZone: ZONE },
    );
    expect(before.transcript).toBe('[02:30] Ola: still summer time');
    expect(after.transcript).toBe('[02:30] Ola: now winter time');
  });

  it('respects thread ids present in the input without filtering by them (scoping is the store\'s job)', () => {
    const result = assembleCorpus(
      [
        msg({ messageId: 1, ts: '2026-09-17T10:00:00Z', threadId: asThreadId(1), text: 'in topic A' }),
        msg({ messageId: 2, ts: '2026-09-17T10:01:00Z', threadId: asThreadId(2), text: 'in topic B' }),
      ],
      { timeZone: ZONE },
    );
    expect(result.messageCount).toBe(2);
    expect(result.transcript).toContain('in topic A');
    expect(result.transcript).toContain('in topic B');
  });
});
