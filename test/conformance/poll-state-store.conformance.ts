/** `PollStateStore` port conformance — the single-row cursor (DESIGN §3, §4). */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { PollStateStore } from '../../src/application/ports/driven/poll-state-store.js';
import { at } from './support.js';
import type { ConformanceFactory } from './support.js';

export function runPollStateStoreConformance(
  label: string,
  factory: ConformanceFactory<PollStateStore>,
): void {
  describe(`PollStateStore conformance (${label})`, () => {
    let store: PollStateStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      store = fixture.store;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('is empty on a fresh database', async () => {
      expect(await store.load()).toBeNull();
    });

    it('holds exactly one state, the most recent', async () => {
      await store.save({ lastUpdateId: 100, lastSeenAt: at(0) });
      await store.save({ lastUpdateId: 205, lastSeenAt: at(5) });

      const state = await store.load();
      expect(state?.lastUpdateId).toBe(205);
      expect(state?.lastSeenAt.epochMilliseconds).toBe(at(5).epochMilliseconds);
    });

    it('clears back to empty', async () => {
      await store.save({ lastUpdateId: 1, lastSeenAt: at(0) });
      await store.clear();
      expect(await store.load()).toBeNull();
    });
  });
}
