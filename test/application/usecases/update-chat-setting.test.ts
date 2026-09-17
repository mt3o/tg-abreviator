/**
 * `/tldr tz`, `/tldr model`, `/tldr dm` (DESIGN §2, §10).
 *
 * The pairing under test is "write SQLite *and* invalidate the derived config
 * for that chat" — chat settings are live precisely because they are a
 * DB-backed configuration layer, and a write that skipped the invalidation
 * would keep serving the old value until the next restart.
 */
import { describe, expect, it } from 'vitest';

import { UpdateChatSettingUseCase } from '../../../src/application/usecases/update-chat-setting.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { FakeConfig } from '../../fakes/fake-config.js';
import { FakeSettingsStore } from '../../fakes/fake-settings-store.js';
import { CHAT_A, USER_ALA } from '../../conformance/support.js';

const AT = Temporal.Instant.from('2026-09-17T12:00:00Z');

function makeCase() {
  const settings = new FakeSettingsStore();
  const config = new FakeConfig();
  return { settings, config, useCase: new UpdateChatSettingUseCase({ settings, config }) };
}

/** Builds a derived view so there is a cache entry for the write to invalidate. */
async function warmDerivedConfig(config: FakeConfig): Promise<number> {
  await config.forChat(CHAT_A);
  return config.derivations;
}

describe('UpdateChatSettingUseCase', () => {
  it('writes the timezone and invalidates the derived config', async () => {
    const c = makeCase();
    const derivations = await warmDerivedConfig(c.config);

    const result = await c.useCase.execute({
      chatId: CHAT_A,
      change: { kind: 'timeZone', timeZone: 'Europe/Warsaw' },
      requestedBy: USER_ALA,
      at: AT,
    });

    expect(result.kind).toBe('chatSettings');
    if (result.kind !== 'chatSettings') return;
    expect(result.settings.tz).toBe('Europe/Warsaw');
    expect(result.settings.updatedBy).toBe(USER_ALA);
    expect((await c.settings.getChatSettings(CHAT_A))?.tz).toBe('Europe/Warsaw');

    await c.config.forChat(CHAT_A);
    expect(c.config.derivations).toBe(derivations + 1);
  });

  it('writes the model alias and invalidates the derived config', async () => {
    const c = makeCase();
    const derivations = await warmDerivedConfig(c.config);

    const result = await c.useCase.execute({
      chatId: CHAT_A,
      change: { kind: 'model', alias: 'haiku' },
      requestedBy: USER_ALA,
      at: AT,
    });

    expect(result.kind).toBe('chatSettings');
    expect((await c.settings.getChatSettings(CHAT_A))?.modelAlias).toBe('haiku');
    await c.config.forChat(CHAT_A);
    expect(c.config.derivations).toBe(derivations + 1);
  });

  it('leaves the timezone alone when only the model changes', async () => {
    const c = makeCase();
    await c.useCase.execute({
      chatId: CHAT_A,
      change: { kind: 'timeZone', timeZone: 'Europe/Warsaw' },
      requestedBy: USER_ALA,
      at: AT,
    });
    await c.useCase.execute({
      chatId: CHAT_A,
      change: { kind: 'model', alias: 'haiku' },
      requestedBy: USER_ALA,
      at: AT,
    });

    const row = await c.settings.getChatSettings(CHAT_A);
    expect(row?.tz).toBe('Europe/Warsaw');
    expect(row?.modelAlias).toBe('haiku');
  });

  it('writes dm delivery to the caller\'s own user prefs, not the chat settings', async () => {
    const c = makeCase();
    const derivations = await warmDerivedConfig(c.config);

    const result = await c.useCase.execute({
      chatId: CHAT_A,
      change: { kind: 'dmDelivery', enabled: true },
      requestedBy: USER_ALA,
      at: AT,
    });

    expect(result.kind).toBe('userPrefs');
    if (result.kind !== 'userPrefs') return;
    expect(result.prefs.dmDelivery).toBe(true);
    expect(result.prefs.userId).toBe(USER_ALA);
    expect(await c.settings.getChatSettings(CHAT_A)).toBeNull();

    // A per-user preference is not part of the `chat` config layer, so there
    // is nothing to invalidate and no Proxy to rebuild.
    await c.config.forChat(CHAT_A);
    expect(c.config.derivations).toBe(derivations);
  });
});
