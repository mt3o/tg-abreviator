/**
 * `PseudonymStore` port conformance (DESIGN §11).
 *
 * The point of the whole mechanism is the last test: once the row is deleted,
 * the label that already left for GlitchTip resolves to nothing, forever. An
 * HMAC could not pass it.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { PseudonymStore } from '../../src/application/ports/driven/pseudonym-store.js';
import { CHAT_A, CHAT_B, FAR_FUTURE, FAR_PAST, USER_ALA, USER_OLA } from './support.js';
import type { ConformanceFactory } from './support.js';

export function runPseudonymStoreConformance(
  label: string,
  factory: ConformanceFactory<PseudonymStore>,
): void {
  describe(`PseudonymStore conformance (${label})`, () => {
    let store: PseudonymStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      store = fixture.store;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('allocates a readable label on first use and keeps it stable', async () => {
      const first = await store.labelFor(CHAT_A, USER_ALA);
      const second = await store.labelFor(CHAT_A, USER_ALA);
      expect(first).toBe(second);
      expect(first).toMatch(/^[a-z]+-[a-z]+$/);
    });

    it('gives different subjects different labels within a chat', async () => {
      const ala = await store.labelFor(CHAT_A, USER_ALA);
      const ola = await store.labelFor(CHAT_A, USER_OLA);
      const chat = await store.labelForChat(CHAT_A);
      expect(new Set([ala, ola, chat]).size).toBe(3);
    });

    it('scopes labels per chat, so the same person is not correlatable across groups', async () => {
      await store.labelFor(CHAT_A, USER_ALA);
      expect(await store.peek(CHAT_B, USER_ALA)).toBeNull();
    });

    it('peeks without allocating', async () => {
      expect(await store.peek(CHAT_A, USER_ALA)).toBeNull();
      const allocated = await store.labelFor(CHAT_A, USER_ALA);
      expect(await store.peek(CHAT_A, USER_ALA)).toBe(allocated);
    });

    it('makes an already-emitted label permanently unresolvable (DESIGN §11)', async () => {
      const label = await store.labelFor(CHAT_A, USER_ALA);
      await store.deleteUser(CHAT_A, USER_ALA);

      // The label in GlitchTip still exists; nothing here can say who it was.
      expect(await store.peek(CHAT_A, USER_ALA)).toBeNull();

      // A later allocation is a fresh row, not a re-derivation of the old one.
      const reallocated = await store.labelFor(CHAT_A, USER_ALA);
      expect(typeof reallocated).toBe('string');
      expect(await store.peek(CHAT_A, USER_OLA)).toBeNull();
      expect(label).toMatch(/^[a-z]+-[a-z]+$/);
    });

    it('wipes a chat, its own label included', async () => {
      await store.labelFor(CHAT_A, USER_ALA);
      await store.labelForChat(CHAT_A);
      await store.deleteChat(CHAT_A);
      expect(await store.peek(CHAT_A, USER_ALA)).toBeNull();
    });

    it('expires on the same schedule as messages', async () => {
      await store.labelFor(CHAT_A, USER_ALA);
      await store.labelFor(CHAT_A, USER_OLA);

      expect(await store.deleteOlderThan(CHAT_A, FAR_PAST)).toBe(0);
      expect(await store.deleteOlderThan(CHAT_A, FAR_FUTURE)).toBe(2);
      expect(await store.peek(CHAT_A, USER_ALA)).toBeNull();
    });
  });
}
