/**
 * WS7 DoD (PLAN.md):
 *
 * - precedence across all four layers
 * - a chat override shadowing `file` and `env`
 * - a routing rule naming an unknown model fails boot with a readable error
 * - a cache-invalidation test proving a settings write is visible on the next
 *   read
 * - a test proving no config key uses the reserved names `__inspect` /
 *   `__derive` / `get` / `getAll`
 *
 * A minimal in-memory `SettingsStore` is hand-written below rather than
 * imported from `test/fakes/**`: a file under `src/adapters` may not import
 * `test/**` (eslint import-boundary rules, DESIGN §3, CI-enforced) — see
 * `src/adapters/outbound/sqlite/forgetme-cascade.test.ts` for the same
 * pattern.
 */
import { describe, expect, it } from 'vitest';

import { createConfig } from './config-layers-adapter.js';
import { DEFAULT_CONFIG } from '../../../config/defaults.js';
import type { ConfigLayer, EnvSource } from '../../../config/schema.js';
import { ConfigValidationError } from '../../../domain/errors.js';
import { asChatId, asUserId } from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import { Temporal } from '../../../domain/time/temporal.js';
import type {
  ChatSettings,
  ChatSettingsPatch,
  UserPrefs,
  UserPrefsPatch,
} from '../../../domain/model/settings.js';
import type { SettingsStore } from '../../../application/ports/driven/settings-store.js';

/** In-memory `SettingsStore` stand-in — see the file header. */
class InMemorySettingsStore implements SettingsStore {
  readonly #chats = new Map<ChatId, ChatSettings>();

  async getChatSettings(chatId: ChatId): Promise<ChatSettings | null> {
    return await Promise.resolve(this.#chats.get(chatId) ?? null);
  }

  async putChatSettings(
    chatId: ChatId,
    patch: ChatSettingsPatch,
    updatedBy: UserId,
    at: Temporal.Instant,
  ): Promise<ChatSettings> {
    const current: ChatSettings = this.#chats.get(chatId) ?? {
      chatId,
      tz: null,
      modelAlias: null,
      updatedBy: null,
      updatedAt: null,
    };
    const next: ChatSettings = {
      chatId,
      tz: patch.tz === undefined ? current.tz : patch.tz,
      modelAlias: patch.modelAlias === undefined ? current.modelAlias : patch.modelAlias,
      updatedBy,
      updatedAt: at,
    };
    this.#chats.set(chatId, next);
    return await Promise.resolve(next);
  }

  getUserPrefs(_chatId: ChatId, _userId: UserId): Promise<UserPrefs | null> {
    throw new Error('not used by this test');
  }

  putUserPrefs(_chatId: ChatId, _userId: UserId, _patch: UserPrefsPatch): Promise<UserPrefs> {
    throw new Error('not used by this test');
  }

  async deleteUser(chatId: ChatId, _userId: UserId): Promise<void> {
    void chatId;
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    this.#chats.delete(chatId);
    await Promise.resolve();
  }
}

const CHAT_ID = asChatId(-1000000000001);
const OPERATOR = asUserId(42);
const NOW = Temporal.Instant.fromEpochMilliseconds(0);

/** Everything `crossValidateResolved` needs beyond `DEFAULT_CONFIG`. */
const MINIMAL_FILE: ConfigLayer = {
  telegram: { allowlist: [-1000000000001] },
  bot: { operatorContact: '@test-operator' },
};
const MINIMAL_ENV: EnvSource = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-api-key',
};

function settingsStore(): InMemorySettingsStore {
  return new InMemorySettingsStore();
}

describe('createConfig — boot validation', () => {
  it('boots from defaults + a minimal file layer + env', async () => {
    const config = await createConfig({
      fileConfig: MINIMAL_FILE,
      env: MINIMAL_ENV,
      settingsStore: settingsStore(),
    });
    expect(config.get('models').default).toBe('sonnet');
    expect(config.get('telegram').token).toBe('test-bot-token');
    expect(config.get('telegram').allowlist).toEqual([-1000000000001]);
    expect(config.get('limits').maxMessagesPerRange).toBe(DEFAULT_CONFIG.limits.maxMessagesPerRange);
  });

  it('fails fast with a readable error when BOT_TOKEN is missing', async () => {
    await expect(
      createConfig({ fileConfig: MINIMAL_FILE, env: {}, settingsStore: settingsStore() }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('collects every layer-shape issue rather than throwing on the first', async () => {
    // Two independent problems in the `file` layer: a `commandName` that
    // fails its regex, and a negative `cooldownSeconds`. Both must surface.
    const fileConfig = {
      ...MINIMAL_FILE,
      bot: { ...MINIMAL_FILE.bot, commandName: 'NOT VALID!' },
      guards: { cooldownSeconds: -5 },
    } as unknown as ConfigLayer;
    try {
      await createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: settingsStore() });
      expect.fail('expected createConfig to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      const paths = issues.map((issue) => issue.path);
      expect(paths).toContain('file.bot.commandName');
      expect(paths).toContain('file.guards.cooldownSeconds');
      // Every issue carries a human-readable message, not just a path.
      for (const issue of issues) {
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('an empty allowlist fails the resolved cross-check even though every layer is individually well-shaped', async () => {
    const fileConfig: ConfigLayer = { bot: { operatorContact: '@test-operator' } };
    try {
      await createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: settingsStore() });
      expect.fail('expected createConfig to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.some((issue) => issue.path === 'telegram.allowlist')).toBe(true);
    }
  });

  it('a registry entry whose apiKeyEnv is unset fails the resolved cross-check', async () => {
    // BOT_TOKEN present, but ANTHROPIC_API_KEY (the default registry's
    // apiKeyEnv) is not — the shape is fine, only the cross-check can see this.
    const env: EnvSource = { BOT_TOKEN: 'test-bot-token' };
    try {
      await createConfig({ fileConfig: MINIMAL_FILE, env, settingsStore: settingsStore() });
      expect.fail('expected createConfig to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.some((issue) => issue.path.includes('apiKeyEnv'))).toBe(true);
    }
  });

  it('a routing rule naming an unknown model fails boot with a readable error', async () => {
    const fileConfig: ConfigLayer = {
      ...MINIMAL_FILE,
      models: { routing: [{ when: { phase: 'reduce' }, use: 'does-not-exist' }] },
    };
    try {
      await createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: settingsStore() });
      expect.fail('expected createConfig to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      const routingIssue = issues.find((issue) => issue.path === 'models.routing.0.use');
      expect(routingIssue).toBeDefined();
      expect(routingIssue?.message).toContain('does-not-exist');
      expect(routingIssue?.message).toContain('not in the registry');
    }
  });

  it('a priced model missing from the registry fails boot', async () => {
    const fileConfig: ConfigLayer = {
      ...MINIMAL_FILE,
      models: { prices: { 'claude-ghost': { inputPerMTokUsd: 1, outputPerMTokUsd: 1, cacheReadPerMTokUsd: 0 } } },
    };
    await expect(
      createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: settingsStore() }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('ttlDays above the env hard cap fails boot', async () => {
    const fileConfig: ConfigLayer = { ...MINIMAL_FILE, retention: { ttlDays: 400 } };
    const env: EnvSource = { ...MINIMAL_ENV, TTL_HARD_CAP_DAYS: '90' };
    await expect(
      createConfig({ fileConfig, env, settingsStore: settingsStore() }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('rejects a bot token placed in the file layer (env-only, DESIGN §10)', async () => {
    const fileConfig = { ...MINIMAL_FILE, telegram: { ...MINIMAL_FILE.telegram, token: 'leaked' } };
    await expect(
      createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: settingsStore() }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('rejects a config key using a reserved config-layers name', async () => {
    // `__inspect` / `__derive` / `get` / `getAll` are reserved (DESIGN §10).
    // A section is `.strict()`, so an unrecognised key is rejected at the
    // file-layer shape check already — the end-to-end guarantee this test
    // exists to prove holds regardless of which validation step catches it.
    const fileConfig = {
      ...MINIMAL_FILE,
      bot: { ...MINIMAL_FILE.bot, __inspect: 'nope' },
    } as unknown as ConfigLayer;
    await expect(
      createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: settingsStore() }),
    ).rejects.toThrow(ConfigValidationError);
  });
});

describe('createConfig — precedence across all four layers', () => {
  it('defaults < file < env < chat, on the same key path', async () => {
    const fileConfig: ConfigLayer = {
      ...MINIMAL_FILE,
      timezone: { default: 'Europe/Berlin' },
      retention: { hardCapDays: 120 },
    };
    const env: EnvSource = { ...MINIMAL_ENV, TTL_HARD_CAP_DAYS: '45' };
    const store = settingsStore();
    await store.putChatSettings(CHAT_ID, { tz: 'America/New_York' }, OPERATOR, NOW);

    const config = await createConfig({ fileConfig, env, settingsStore: store });

    // defaults: Europe/Warsaw; file: Europe/Berlin; env silent on tz; chat: New York.
    expect(DEFAULT_CONFIG.timezone.default).toBe('Europe/Warsaw');
    expect(config.get('timezone').default).toBe('Europe/Berlin'); // file beats defaults
    const chatView = await config.forChat(CHAT_ID);
    expect(chatView.get('timezone').default).toBe('America/New_York'); // chat beats file

    // retention.hardCapDays: defaults 90 < file 120 < env 45 (env is highest
    // of the three boot layers, even though 45 < 120 — precedence, not size).
    expect(config.get('retention').hardCapDays).toBe(45);
  });

  it('a chat override shadows both file and env for the keys it touches, and nothing else', async () => {
    const fileConfig: ConfigLayer = { ...MINIMAL_FILE, models: { default: 'haiku' } };
    const store = settingsStore();
    await store.putChatSettings(CHAT_ID, { modelAlias: 'sonnet' }, OPERATOR, NOW);

    const config = await createConfig({ fileConfig, env: MINIMAL_ENV, settingsStore: store });
    expect(config.get('models').default).toBe('haiku');

    const chatView = await config.forChat(CHAT_ID);
    expect(chatView.get('models').default).toBe('sonnet');
    // The registry itself is untouched by the chat layer.
    expect(chatView.get('models').registry).toEqual(config.get('models').registry);
  });

  it('__inspect reports which layer supplied a value, lowest priority first', async () => {
    const fileConfig: ConfigLayer = { ...MINIMAL_FILE, timezone: { default: 'Europe/Berlin' } };
    const config = await createConfig({
      fileConfig,
      env: MINIMAL_ENV,
      settingsStore: settingsStore(),
    });

    const origin = config.inspect('timezone.default');
    expect(origin.layer).toBe('file');
    expect(origin.value).toBe('Europe/Berlin');
    expect(origin.candidates.map((candidate) => candidate.layer)).toEqual(['defaults', 'file', 'env']);
    const active = origin.candidates.filter((candidate) => candidate.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.layer).toBe('file');
  });

  it('a chat-derived inspect adds "chat" as the highest-priority candidate', async () => {
    const store = settingsStore();
    await store.putChatSettings(CHAT_ID, { tz: 'Asia/Tokyo' }, OPERATOR, NOW);
    const config = await createConfig({
      fileConfig: MINIMAL_FILE,
      env: MINIMAL_ENV,
      settingsStore: store,
    });

    const chatView = await config.forChat(CHAT_ID);
    const origin = chatView.inspect('timezone.default');
    expect(origin.layer).toBe('chat');
    expect(origin.value).toBe('Asia/Tokyo');
    expect(origin.candidates.map((candidate) => candidate.layer)).toEqual([
      'defaults',
      'file',
      'env',
      'chat',
    ]);
  });
});

describe('createConfig — per-chat cache and invalidation', () => {
  it('does not re-derive on a second read of the same chat', async () => {
    const store = settingsStore();
    await store.putChatSettings(CHAT_ID, { tz: 'Europe/Berlin' }, OPERATOR, NOW);
    const config = await createConfig({
      fileConfig: MINIMAL_FILE,
      env: MINIMAL_ENV,
      settingsStore: store,
    });

    const first = await config.forChat(CHAT_ID);
    const second = await config.forChat(CHAT_ID);
    // Same cached view: a Proxy is not constructed per request (DESIGN §10).
    expect(second).toBe(first);
  });

  it('a settings write becomes visible on the next read only after invalidateChat', async () => {
    const store = settingsStore();
    const config = await createConfig({
      fileConfig: MINIMAL_FILE,
      env: MINIMAL_ENV,
      settingsStore: store,
    });

    const before = await config.forChat(CHAT_ID);
    expect(before.get('timezone').default).toBe(DEFAULT_CONFIG.timezone.default);

    await store.putChatSettings(CHAT_ID, { tz: 'Pacific/Auckland' }, OPERATOR, NOW);

    // Still cached: the write alone does not invalidate anything.
    const stillCached = await config.forChat(CHAT_ID);
    expect(stillCached.get('timezone').default).toBe(DEFAULT_CONFIG.timezone.default);

    config.invalidateChat(CHAT_ID);

    const after = await config.forChat(CHAT_ID);
    expect(after.get('timezone').default).toBe('Pacific/Auckland');
    expect(after).not.toBe(before);
  });

  it('invalidating one chat does not disturb another chat\'s cached view', async () => {
    const otherChatId = asChatId(-2000000000002);
    const store = settingsStore();
    await store.putChatSettings(CHAT_ID, { tz: 'Europe/Berlin' }, OPERATOR, NOW);
    await store.putChatSettings(otherChatId, { tz: 'Asia/Tokyo' }, OPERATOR, NOW);
    const config = await createConfig({
      fileConfig: MINIMAL_FILE,
      env: MINIMAL_ENV,
      settingsStore: store,
    });

    const a = await config.forChat(CHAT_ID);
    const b = await config.forChat(otherChatId);
    config.invalidateChat(CHAT_ID);
    const aAgain = await config.forChat(CHAT_ID);
    const bAgain = await config.forChat(otherChatId);

    expect(aAgain).not.toBe(a);
    expect(bAgain).toBe(b);
    expect(bAgain.get('timezone').default).toBe('Asia/Tokyo');
  });
});
