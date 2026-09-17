/**
 * Table-driven tests for `resolve()` (DESIGN §2, §3; WS3 DoD).
 *
 * Covers: reply-anchor + explicit range (explicit wins), DST boundaries, and
 * the resolution behaviour of every `RangeSpec` kind `parse()` can produce.
 */
import { describe, expect, it } from 'vitest';

import { Temporal } from '../time/temporal.js';
import { asMessageId, asThreadId } from '../model/ids.js';
import { MAX_RANGE_MESSAGES_HARD_CAP, type RangeResolutionContext, type RangeSpec } from '../model/range.js';
import { threadScope } from '../model/scope.js';
import { resolve } from './resolve.js';

const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const WARSAW = 'Europe/Warsaw';

function baseCtx(overrides: Partial<RangeResolutionContext> = {}): RangeResolutionContext {
  return {
    now: NOW,
    timeZone: WARSAW,
    scope: threadScope(null),
    replyAnchor: null,
    defaultRangeDays: 2,
    maxMessages: 500,
    storedHorizon: null,
    ...overrides,
  };
}

describe('resolve() — end is always now', () => {
  it('every spec kind resolves with end === ctx.now', () => {
    const specs: RangeSpec[] = [
      { kind: 'default', raw: '' },
      { kind: 'messageCount', raw: '-50', count: 50 },
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
    ];
    for (const spec of specs) {
      const resolved = resolve(spec, baseCtx());
      expect(Temporal.Instant.compare(resolved.end, NOW)).toBe(0);
    }
  });
});

describe('resolve() — message count', () => {
  it('-50 becomes a lastN start, limit matches the count', () => {
    const resolved = resolve({ kind: 'messageCount', raw: '-50', count: 50 }, baseCtx());
    expect(resolved.start).toEqual({ kind: 'lastN', count: 50 });
    expect(resolved.limit).toBe(50);
    expect(resolved.basis).toBe('explicit');
    expect(resolved.clampedToHorizon).toBe(false);
  });

  it('is clamped by the chat maxMessages configuration, never above it', () => {
    const resolved = resolve(
      { kind: 'messageCount', raw: '-500', count: 500 },
      baseCtx({ maxMessages: 100 }),
    );
    expect(resolved.start).toEqual({ kind: 'lastN', count: 100 });
    expect(resolved.limit).toBe(100);
  });
});

describe('resolve() — duration', () => {
  it('2h resolves to an instant start 2 hours before now', () => {
    const resolved = resolve(
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      baseCtx(),
    );
    expect(resolved.start.kind).toBe('instant');
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    expect(Temporal.Instant.compare(start.ts, NOW.subtract({ hours: 2 }))).toBe(0);
    expect(resolved.basis).toBe('explicit');
  });

  it('limit is capped at the hard cap of 500 even with a generous chat config', () => {
    const resolved = resolve(
      { kind: 'duration', raw: '1w', duration: { unit: 'weeks', amount: 1 } },
      baseCtx({ maxMessages: 10_000 }),
    );
    expect(resolved.limit).toBe(MAX_RANGE_MESSAGES_HARD_CAP);
  });
});

describe('resolve() — since a date', () => {
  it('2026-09-15 resolves to local midnight of that date in the chat zone', () => {
    const resolved = resolve(
      { kind: 'sinceDate', raw: '2026-09-15', date: Temporal.PlainDate.from('2026-09-15') },
      baseCtx(),
    );
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    const expected = Temporal.PlainDate.from('2026-09-15').toZonedDateTime(WARSAW).toInstant();
    expect(Temporal.Instant.compare(start.ts, expected)).toBe(0);
  });
});

describe('resolve() — named windows', () => {
  it('yesterday resolves to local midnight of the previous day', () => {
    const resolved = resolve({ kind: 'namedWindow', raw: 'yesterday', window: 'yesterday' }, baseCtx());
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    // NOW is 2026-09-17T12:00Z = 2026-09-17T14:00 Warsaw (CEST, +2), so "today"
    // in the chat zone is 2026-09-17 and "yesterday" starts 2026-09-16 00:00.
    const expected = Temporal.PlainDate.from('2026-09-16').toZonedDateTime(WARSAW).toInstant();
    expect(Temporal.Instant.compare(start.ts, expected)).toBe(0);
  });

  it('lastWeek starts on the Monday before this week (ISO week)', () => {
    const resolved = resolve({ kind: 'namedWindow', raw: 'last week', window: 'lastWeek' }, baseCtx());
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    // 2026-09-17 is a Thursday; this week's Monday is 2026-09-14, last week's
    // Monday is 2026-09-07.
    const expected = Temporal.PlainDate.from('2026-09-07').toZonedDateTime(WARSAW).toInstant();
    expect(Temporal.Instant.compare(start.ts, expected)).toBe(0);
  });

  it('thisMonth starts on the 1st of the current month', () => {
    const resolved = resolve({ kind: 'namedWindow', raw: 'this month', window: 'thisMonth' }, baseCtx());
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    const expected = Temporal.PlainDate.from('2026-09-01').toZonedDateTime(WARSAW).toInstant();
    expect(Temporal.Instant.compare(start.ts, expected)).toBe(0);
  });

  it('lastMonth starts on the 1st of the previous month', () => {
    const resolved = resolve({ kind: 'namedWindow', raw: 'last month', window: 'lastMonth' }, baseCtx());
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    const expected = Temporal.PlainDate.from('2026-08-01').toZonedDateTime(WARSAW).toInstant();
    expect(Temporal.Instant.compare(start.ts, expected)).toBe(0);
  });
});

describe('resolve() — default range', () => {
  it('is defaultRangeDays before now, basis "default"', () => {
    const resolved = resolve({ kind: 'default', raw: '' }, baseCtx({ defaultRangeDays: 2 }));
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    expect(Temporal.Instant.compare(start.ts, NOW.subtract({ hours: 48 }))).toBe(0);
    expect(resolved.basis).toBe('default');
    expect(resolved.limit).toBe(MAX_RANGE_MESSAGES_HARD_CAP);
  });
});

describe('resolve() — reply anchor vs. explicit range (DESIGN §2)', () => {
  const anchor = asMessageId(4242);

  it('no explicit range, a reply anchor present: basis "replyAnchor", inclusive message start', () => {
    const resolved = resolve({ kind: 'default', raw: '' }, baseCtx({ replyAnchor: anchor }));
    expect(resolved.start).toEqual({ kind: 'message', messageId: anchor, inclusive: true });
    expect(resolved.basis).toBe('replyAnchor');
  });

  it('an explicit range wins over a reply anchor when both are present', () => {
    const resolved = resolve(
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      baseCtx({ replyAnchor: anchor }),
    );
    expect(resolved.start.kind).toBe('instant');
    expect(resolved.basis).toBe('explicit');
  });

  it('a reply-anchor spec built directly (not synthesized) resolves as explicit', () => {
    const resolved = resolve({ kind: 'replyAnchor', raw: '', messageId: anchor }, baseCtx());
    expect(resolved.start).toEqual({ kind: 'message', messageId: anchor, inclusive: true });
    expect(resolved.basis).toBe('explicit');
  });

  it('no range and no reply anchor: falls back to the default window', () => {
    const resolved = resolve({ kind: 'default', raw: '' }, baseCtx({ replyAnchor: null }));
    expect(resolved.start.kind).toBe('instant');
    expect(resolved.basis).toBe('default');
  });
});

describe('resolve() — horizon clamping', () => {
  it('clamps a start that reaches before the stored horizon and flags it', () => {
    const horizon = NOW.subtract({ hours: 1 });
    const resolved = resolve(
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      baseCtx({ storedHorizon: horizon }),
    );
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    expect(Temporal.Instant.compare(start.ts, horizon)).toBe(0);
    expect(resolved.clampedToHorizon).toBe(true);
  });

  it('does not clamp when the requested start is within the stored horizon', () => {
    const horizon = NOW.subtract({ hours: 30 * 24 });
    const resolved = resolve(
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      baseCtx({ storedHorizon: horizon }),
    );
    expect(resolved.clampedToHorizon).toBe(false);
  });

  it('does not apply to a lastN (message-count) start', () => {
    const horizon = NOW.subtract({ hours: 1 });
    const resolved = resolve(
      { kind: 'messageCount', raw: '-50', count: 50 },
      baseCtx({ storedHorizon: horizon }),
    );
    expect(resolved.clampedToHorizon).toBe(false);
  });

  it('does not apply to a reply-anchor start', () => {
    const horizon = NOW.subtract({ hours: 1 });
    const resolved = resolve(
      { kind: 'default', raw: '' },
      baseCtx({ storedHorizon: horizon, replyAnchor: asMessageId(1) }),
    );
    expect(resolved.clampedToHorizon).toBe(false);
  });
});

describe('resolve() — DST correctness (DESIGN §3)', () => {
  it('a 3-day range across the Europe/Warsaw October fall-back is 73 hours, not 72', () => {
    // 2026-10-25 is the last Sunday of October: DST ends, clocks go back an
    // hour at 03:00 CEST -> 02:00 CET, so that day has 25 wall-clock hours.
    const now = Temporal.ZonedDateTime.from('2026-10-28T00:30:00[Europe/Warsaw]').toInstant();
    const resolved = resolve(
      { kind: 'duration', raw: '3d', duration: { unit: 'days', amount: 3 } },
      baseCtx({ now, timeZone: WARSAW }),
    );
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    const elapsedHours = now.since(start.ts).total({ unit: 'hours' });
    expect(elapsedHours).toBe(73);
  });

  it('a 3-day range that does not cross the transition is a plain 72 hours', () => {
    const now = Temporal.ZonedDateTime.from('2026-09-20T00:30:00[Europe/Warsaw]').toInstant();
    const resolved = resolve(
      { kind: 'duration', raw: '3d', duration: { unit: 'days', amount: 3 } },
      baseCtx({ now, timeZone: WARSAW }),
    );
    const start = resolved.start as Extract<typeof resolved.start, { kind: 'instant' }>;
    const elapsedHours = now.since(start.ts).total({ unit: 'hours' });
    expect(elapsedHours).toBe(72);
  });
});

describe('resolve() — scope and time zone pass through unchanged', () => {
  it('carries ctx.scope and ctx.timeZone onto the resolved range', () => {
    const scope = threadScope(asThreadId(7));
    const resolved = resolve(
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      baseCtx({ scope }),
    );
    expect(resolved.scope).toEqual(scope);
    expect(resolved.timeZone).toBe(WARSAW);
    expect(resolved.spec).toEqual({ kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } });
  });
});
