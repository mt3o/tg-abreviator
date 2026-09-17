/**
 * `outbound/system` — the `Clock` and `IdGenerator` adapters (DESIGN §3).
 *
 * Small, but not trivia: these are the two ports the whole codebase is
 * forbidden to bypass, and `IdGenerator.token()` is the one that has to be
 * genuinely random or `/forgetme` is not erasure (DESIGN §5).
 */
import { describe, expect, it } from 'vitest';

import { RandomIdGenerator } from '../../../../src/adapters/outbound/system/random-id-generator.js';
import { SystemClock } from '../../../../src/adapters/outbound/system/system-clock.js';

describe('SystemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now();
    const now = new SystemClock().now().epochMilliseconds;
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('answers in a chat zone, which is what DST-correct range arithmetic needs', () => {
    const clock = new SystemClock();
    const warsaw = clock.nowIn('Europe/Warsaw');
    const utc = clock.nowIn('UTC');

    expect(warsaw.timeZoneId).toBe('Europe/Warsaw');
    // Same instant, different local wall time.
    expect(Math.abs(warsaw.epochMilliseconds - utc.epochMilliseconds)).toBeLessThan(1000);
    expect(warsaw.offset).not.toBe('+00:00');
  });

  it('actually waits, because 429 retry_after is authoritative (DESIGN §8)', async () => {
    const started = Date.now();
    await new SystemClock().sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('treats a negative duration as no wait rather than throwing', async () => {
    await expect(new SystemClock().sleep(-5)).resolves.toBeUndefined();
  });
});

describe('RandomIdGenerator', () => {
  const ids = new RandomIdGenerator();

  it('issues unique uuids', () => {
    const issued = new Set(Array.from({ length: 100 }, () => ids.uuid()));
    expect(issued.size).toBe(100);
    for (const id of issued) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('issues hex tokens of the requested byte length, all distinct', () => {
    expect(ids.token()).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.token(8)).toMatch(/^[0-9a-f]{16}$/);
    const issued = new Set(Array.from({ length: 100 }, () => ids.token()));
    expect(issued.size).toBe(100);
  });

  it('bounds randomInt and rejects a nonsensical bound', () => {
    for (let index = 0; index < 200; index += 1) {
      const value = ids.randomInt(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
    }
    expect(() => ids.randomInt(0)).toThrow(RangeError);
    expect(() => ids.randomInt(2.5)).toThrow(RangeError);
  });
});
