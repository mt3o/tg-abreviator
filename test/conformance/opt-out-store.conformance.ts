/** `OptOutStore` port conformance — `opt_outs` (DESIGN §5). */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { OptOutStore } from '../../src/application/ports/driven/opt-out-store.js';
import { CHAT_A, CHAT_B, USER_ALA, USER_OLA } from './support.js';
import type { ConformanceFactory } from './support.js';

export function runOptOutStoreConformance(
  label: string,
  factory: ConformanceFactory<OptOutStore>,
): void {
  describe(`OptOutStore conformance (${label})`, () => {
    let store: OptOutStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      store = fixture.store;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('defaults to opted in', async () => {
      expect(await store.isOptedOut(CHAT_A, USER_ALA)).toBe(false);
      expect(await store.listOptedOut(CHAT_A)).toEqual([]);
    });

    it('opts out idempotently, and back in', async () => {
      await store.optOut(CHAT_A, USER_ALA);
      await store.optOut(CHAT_A, USER_ALA);
      expect(await store.isOptedOut(CHAT_A, USER_ALA)).toBe(true);
      expect(await store.listOptedOut(CHAT_A)).toEqual([USER_ALA]);

      await store.optIn(CHAT_A, USER_ALA);
      expect(await store.isOptedOut(CHAT_A, USER_ALA)).toBe(false);
    });

    it('is per chat: opting out of one group is not opting out of another', async () => {
      await store.optOut(CHAT_A, USER_ALA);
      expect(await store.isOptedOut(CHAT_B, USER_ALA)).toBe(false);
      expect(await store.isOptedOut(CHAT_A, USER_OLA)).toBe(false);
    });

    it('wipes a chat', async () => {
      await store.optOut(CHAT_A, USER_ALA);
      await store.deleteChat(CHAT_A);
      expect(await store.listOptedOut(CHAT_A)).toEqual([]);
    });
  });
}
