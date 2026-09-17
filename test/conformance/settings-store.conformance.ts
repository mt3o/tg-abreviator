/** `SettingsStore` port conformance — `chat_settings` and `user_prefs`. */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { SettingsStore } from '../../src/application/ports/driven/settings-store.js';
import { CHAT_A, CHAT_B, USER_ALA, USER_OLA, at } from './support.js';
import type { ConformanceFactory } from './support.js';

export function runSettingsStoreConformance(
  label: string,
  factory: ConformanceFactory<SettingsStore>,
): void {
  describe(`SettingsStore conformance (${label})`, () => {
    let store: SettingsStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      store = fixture.store;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('returns null before anything is set, so every layer below applies', async () => {
      expect(await store.getChatSettings(CHAT_A)).toBeNull();
      expect(await store.getUserPrefs(CHAT_A, USER_ALA)).toBeNull();
    });

    it('applies a patch without disturbing the keys it does not mention', async () => {
      await store.putChatSettings(CHAT_A, { tz: 'Europe/Warsaw' }, USER_ALA, at(0));
      await store.putChatSettings(CHAT_A, { modelAlias: 'haiku' }, USER_OLA, at(1));

      const settings = await store.getChatSettings(CHAT_A);
      expect(settings?.tz).toBe('Europe/Warsaw');
      expect(settings?.modelAlias).toBe('haiku');
      expect(settings?.updatedBy).toBe(USER_OLA);
      expect(settings?.updatedAt?.epochMilliseconds).toBe(at(1).epochMilliseconds);
    });

    it('clears a key with an explicit null', async () => {
      await store.putChatSettings(CHAT_A, { tz: 'Europe/Warsaw' }, USER_ALA, at(0));
      await store.putChatSettings(CHAT_A, { tz: null }, USER_ALA, at(1));
      expect((await store.getChatSettings(CHAT_A))?.tz).toBeNull();
    });

    it('keeps chats apart', async () => {
      await store.putChatSettings(CHAT_A, { modelAlias: 'haiku' }, USER_ALA, at(0));
      expect(await store.getChatSettings(CHAT_B)).toBeNull();
    });

    it('stores a per-user delivery preference per chat', async () => {
      await store.putUserPrefs(CHAT_A, USER_ALA, { dmDelivery: true });
      expect((await store.getUserPrefs(CHAT_A, USER_ALA))?.dmDelivery).toBe(true);
      expect(await store.getUserPrefs(CHAT_B, USER_ALA)).toBeNull();
      expect(await store.getUserPrefs(CHAT_A, USER_OLA)).toBeNull();
    });

    it('deletes a single user as part of the erasure cascade', async () => {
      await store.putUserPrefs(CHAT_A, USER_ALA, { dmDelivery: true });
      await store.putUserPrefs(CHAT_A, USER_OLA, { dmDelivery: true });
      await store.deleteUser(CHAT_A, USER_ALA);

      expect(await store.getUserPrefs(CHAT_A, USER_ALA)).toBeNull();
      expect(await store.getUserPrefs(CHAT_A, USER_OLA)).not.toBeNull();
    });

    it('wipes a chat, settings and preferences alike', async () => {
      await store.putChatSettings(CHAT_A, { tz: 'Europe/Warsaw' }, USER_ALA, at(0));
      await store.putUserPrefs(CHAT_A, USER_ALA, { dmDelivery: true });
      await store.deleteChat(CHAT_A);

      expect(await store.getChatSettings(CHAT_A)).toBeNull();
      expect(await store.getUserPrefs(CHAT_A, USER_ALA)).toBeNull();
    });
  });
}
