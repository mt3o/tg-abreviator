/**
 * Layer 1 — `defaults`, built into the release (DESIGN §10).
 *
 * This layer is why "a minimal user config is five lines, not two hundred".
 * It holds everything except the things only an operator can know: the bot
 * token, the allowlist, the operator ids and the error-sink DSN.
 *
 * It is a `ConfigLayer`, not a `ResolvedConfig`, precisely because of those
 * gaps — the resolved snapshot is what gets validated in full.
 */
import type { ConfigLayer } from './schema.js';

export const DEFAULT_CONFIG = {
  bot: {
    commandName: 'tldr',
    language: 'pl',
    operatorContact: '',
    announceOnJoin: true,
  },
  telegram: {
    // token: env-only.
    allowlist: [],
    operatorUserIds: [],
    pollTimeoutSeconds: 30,
    allowedUpdates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
  },
  database: {
    path: './data/tg-abreviator.db',
    busyTimeoutMs: 5000,
    lockPath: './data/tg-abreviator.lock',
  },
  retention: {
    ttlDays: 30,
    perChatTtlDays: {},
    hardCapDays: 90,
    sweepIntervalMinutes: 60,
    gapThresholdMinutes: 15,
  },
  timezone: {
    default: 'Europe/Warsaw',
  },
  models: {
    default: 'sonnet',
    registry: {
      sonnet: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        maxOutputTokens: 4096,
      },
      haiku: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        maxOutputTokens: 4096,
      },
    },
    // DESIGN §7: map phase on the cheap model, reduce on the strong one.
    routing: [{ when: { phase: 'map' }, use: 'haiku' }],
    prices: {
      'claude-sonnet-5': {
        inputPerMTokUsd: 3,
        outputPerMTokUsd: 15,
        cacheReadPerMTokUsd: 0.3,
      },
      'claude-haiku-4-5': {
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 5,
        cacheReadPerMTokUsd: 0.1,
      },
    },
  },
  prompts: {
    version: 'v1',
  },
  limits: {
    maxInputTokens: 150_000,
    compactThreshold: 60_000,
    maxMessagesPerRange: 500,
    defaultRangeDays: 2,
    maxOutputChars: 3000,
    maxOutputParts: 3,
  },
  guards: {
    cooldownSeconds: 60,
    concurrentPerChat: 1,
    dedupeTtlSeconds: 300,
    dailyCallsPerChat: 50,
    globalDailyBudgetUsd: 5,
  },
  delivery: {
    editThrottleMs: 3000,
    linkPreview: false,
    dmByDefault: false,
  },
  safety: {
    slurs: { pl: [], en: [] },
    redaction: { enabled: true, extraPatterns: [] },
  },
  observability: {
    dsn: null,
    environment: 'dev',
    release: null,
  },
  logging: {
    level: 'info',
    logMessageContents: false,
  },
} as const satisfies ConfigLayer;
