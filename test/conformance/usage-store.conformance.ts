/**
 * `UsageStore` / `GlobalUsageStore` port conformance (DESIGN §4, §5, §9).
 *
 * The important one is `anonymiseUser`: after `/forgetme` the rows must still
 * add up — the operator's bill does not change because someone exercised their
 * rights — while the user reference becomes a token that resolves to nothing.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type {
  GlobalUsageStore,
  UsageStore,
} from '../../src/application/ports/driven/usage-store.js';
import { CHAT_A, CHAT_B, FAR_FUTURE, USER_ALA, USER_OLA, at, makeUsageEvent } from './support.js';
import type { ConformanceFactory } from './support.js';

export interface UsageStoreBundle {
  readonly usage: UsageStore;
  readonly global: GlobalUsageStore;
}

export function runUsageStoreConformance(
  label: string,
  factory: ConformanceFactory<UsageStoreBundle>,
): void {
  describe(`UsageStore conformance (${label})`, () => {
    let usage: UsageStore;
    let global: GlobalUsageStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      usage = fixture.store.usage;
      global = fixture.store.global;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('counts calls inside a window and nothing outside it', async () => {
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u1', ts: at(0) }));
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u2', ts: at(10) }));
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u3', ts: at(100) }));

      expect(await usage.countCalls(CHAT_A, at(0), at(10))).toBe(2);
      expect(await usage.countCalls(CHAT_A, at(11), at(99))).toBe(0);
      expect(await usage.countCalls(CHAT_B, at(0), FAR_FUTURE)).toBe(0);
    });

    it('summarizes tokens and cost, broken down per model', async () => {
      await usage.record(
        CHAT_A,
        makeUsageEvent({ id: 'u1', model: 'claude-haiku-4-5', phase: 'map', costMicros: 1000 }),
      );
      await usage.record(
        CHAT_A,
        makeUsageEvent({ id: 'u2', model: 'claude-haiku-4-5', phase: 'map', costMicros: 1500 }),
      );
      await usage.record(
        CHAT_A,
        makeUsageEvent({ id: 'u3', model: 'claude-sonnet-5', phase: 'reduce', costMicros: 9000 }),
      );

      const summary = await usage.summarize(CHAT_A, at(-1), FAR_FUTURE);
      expect(summary.calls).toBe(3);
      expect(summary.costMicros).toBe(11_500);
      expect(summary.byModel['claude-haiku-4-5']?.calls).toBe(2);
      expect(summary.byModel['claude-haiku-4-5']?.costMicros).toBe(2500);
      expect(summary.byModel['claude-sonnet-5']?.calls).toBe(1);
    });

    it('keeps one chat out of another chat\'s stats', async () => {
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u1', costMicros: 1000 }));
      await usage.record(CHAT_B, makeUsageEvent({ id: 'u2', chatId: CHAT_B, costMicros: 5000 }));

      expect((await usage.summarize(CHAT_A, at(-1), FAR_FUTURE)).costMicros).toBe(1000);
      expect((await usage.summarize(CHAT_B, at(-1), FAR_FUTURE)).costMicros).toBe(5000);
    });

    it('adds every chat up for the global budget hard stop (DESIGN §9)', async () => {
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u1', costMicros: 1000, ts: at(0) }));
      await usage.record(
        CHAT_B,
        makeUsageEvent({ id: 'u2', chatId: CHAT_B, costMicros: 5000, ts: at(1) }),
      );
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u3', costMicros: 250, ts: at(-100) }));

      expect(await global.costMicrosSince(at(0))).toBe(6000);
      expect((await global.summarizeGlobal(at(0), FAR_FUTURE)).calls).toBe(2);
    });

    it('replaces the user reference with an opaque token and leaves the arithmetic alone', async () => {
      await usage.record(
        CHAT_A,
        makeUsageEvent({ id: 'u1', user: { kind: 'user', userId: USER_ALA }, costMicros: 1000 }),
      );
      await usage.record(
        CHAT_A,
        makeUsageEvent({ id: 'u2', user: { kind: 'user', userId: USER_OLA }, costMicros: 2000 }),
      );

      const rewritten = await usage.anonymiseUser(CHAT_A, USER_ALA, 'random-token-abc');
      expect(rewritten).toBe(1);

      // The bill is unchanged; only the identity is gone.
      expect((await usage.summarize(CHAT_A, at(-1), FAR_FUTURE)).costMicros).toBe(3000);

      // And doing it again finds nothing: the id is no longer there to match.
      expect(await usage.anonymiseUser(CHAT_A, USER_ALA, 'random-token-def')).toBe(0);
    });

    it('sweeps on the same schedule as messages', async () => {
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u1', ts: at(0) }));
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u2', ts: at(100) }));

      expect(await usage.deleteOlderThan(CHAT_A, at(50))).toBe(1);
      expect(await usage.countCalls(CHAT_A, at(-1), FAR_FUTURE)).toBe(1);
    });

    it('wipes a chat', async () => {
      await usage.record(CHAT_A, makeUsageEvent({ id: 'u1' }));
      expect(await usage.deleteChat(CHAT_A)).toBe(1);
      expect(await usage.countCalls(CHAT_A, at(-1), FAR_FUTURE)).toBe(0);
    });
  });
}
