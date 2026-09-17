/**
 * Configuration schemas (DESIGN §10).
 *
 * `config-layers` deliberately does not validate at runtime — it relies on
 * static types, which an untyped YAML file bypasses completely. So the boot
 * sequence is: parse `config.yaml`, **Zod-validate each layer's shape before
 * handing it to `fromLayers`**, build the layered config, then
 * **cross-validate the resolved snapshot**, then fail fast with a readable
 * message.
 *
 * Step 4 cannot be a per-layer check: a routing rule in the file may
 * legitimately name a model defined in `defaults`. It has to run against the
 * resolved view. That is `crossValidateResolved()` below.
 *
 * This file is a Phase 0 contract. WS7 owns the adapter that *uses* it
 * (`src/adapters/outbound/config/**`); nothing here imports `config-layers`,
 * because no `config-layers` type may cross the port boundary.
 */
import { z } from 'zod';

import { MAX_RANGE_MESSAGES_HARD_CAP } from '../domain/model/range.js';
import type { ConfigIssue } from '../domain/errors.js';
import type { ChatSettings } from '../domain/model/settings.js';

/* -------------------------------------------------------------------------- */
/* Shared leaf schemas                                                        */
/* -------------------------------------------------------------------------- */

/** DESIGN §10: `__inspect`, `__derive`, `get` and `getAll` are reserved names. */
export const RESERVED_CONFIG_KEYS: readonly string[] = Object.freeze([
  '__inspect',
  '__derive',
  'get',
  'getAll',
]);

const positiveInt = z.int().positive();
const nonNegativeInt = z.int().nonnegative();
const nonNegativeNumber = z.number().nonnegative();

/** Telegram command names: 1–32 chars, lowercase letters, digits, underscores. */
const commandName = z
  .string()
  .regex(/^[a-z0-9_]{1,32}$/, 'must be 1-32 chars of [a-z0-9_]');

/** IANA zone. Shape only here; `crossValidateResolved` proves the zone exists. */
const timeZoneId = z.string().min(1);

/** An environment variable *name*, never a value (DESIGN §7: keys are env-only). */
const envVarName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an UPPER_SNAKE env var name');

const unitPricesSchema = z
  .object({
    inputPerMTokUsd: nonNegativeNumber,
    outputPerMTokUsd: nonNegativeNumber,
    cacheReadPerMTokUsd: nonNegativeNumber,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

const botSection = z
  .object({
    /** DESIGN §2: invocation is always an explicit command, and it is configurable. */
    commandName,
    /** Language of the bot's own strings (header, footer, errors). */
    language: z.enum(['pl', 'en']),
    /** Shown by `/privacy` and in the join announcement (DESIGN §5). */
    operatorContact: z.string(),
    /** DESIGN §5: announce on join, carrying the operator contact. */
    announceOnJoin: z.boolean(),
  })
  .strict();

const telegramSection = z
  .object({
    /** Env-only (`BOT_TOKEN`). Never in the file layer; this repo is public. */
    token: z.string().min(1),
    /**
     * DESIGN §5: the single biggest risk reducer. Anywhere not listed gets
     * "not authorised", `leaveChat`, and **nothing stored**.
     */
    allowlist: z.array(z.int()),
    /** Env-only (`OPERATOR_USER_IDS`). Tier `operator`: anything anywhere. */
    operatorUserIds: z.array(positiveInt),
    /** Long-poll timeout. Telegram allows up to 50. */
    pollTimeoutSeconds: z.int().min(1).max(50),
    /** `callback_query` is required for the 👍/👎 keyboard (DESIGN §12). */
    allowedUpdates: z.array(z.string().min(1)).min(1),
  })
  .strict();

const databaseSection = z
  .object({
    /** Env `DATABASE_PATH`. A host bind mount in Docker, never NFS (DESIGN §3). */
    path: z.string().min(1),
    /** DESIGN §3: `PRAGMA busy_timeout`. */
    busyTimeoutMs: positiveInt,
    /** Single-instance lockfile; a second process must exit loudly (DESIGN §3). */
    lockPath: z.string().min(1),
  })
  .strict();

const retentionSection = z
  .object({
    /** DESIGN §5: global default 30 days. */
    ttlDays: positiveInt,
    /** Per-chat override, keyed by chat id as a string. Operator-only knob. */
    perChatTtlDays: z.record(z.string(), positiveInt),
    /** Env `TTL_HARD_CAP_DAYS`. Nothing can set "forever" without a redeploy. */
    hardCapDays: positiveInt,
    /** How often the TTL sweeper runs. */
    sweepIntervalMinutes: positiveInt,
    /**
     * DESIGN §4: on startup, if `now - last_seen_at` exceeds this, insert a
     * `gap_marker` row. Silent holes destroy trust faster than missing features.
     */
    gapThresholdMinutes: positiveInt,
  })
  .strict();

const timezoneSection = z
  .object({
    /** Fallback when a chat has not set one. The `chat` layer overrides this key. */
    default: timeZoneId,
  })
  .strict();

const modelEntrySchema = z
  .object({
    provider: z.enum(['anthropic']),
    /** Concrete provider model id, e.g. `claude-sonnet-5`. */
    model: z.string().min(1),
    /** DESIGN §7: the *name* of the env var holding the key. Never the key. */
    apiKeyEnv: envVarName,
    maxOutputTokens: positiveInt,
  })
  .strict();

/** DESIGN §7: a small ordered rule list, first match wins — not a DSL. */
const routingRuleSchema = z
  .object({
    when: z
      .object({
        phase: z.enum(['single', 'map', 'reduce']).optional(),
        chatId: z.int().optional(),
        minInputTokens: nonNegativeInt.optional(),
      })
      .strict(),
    /** Registry alias. `crossValidateResolved` proves it exists. */
    use: z.string().min(1),
  })
  .strict();

const modelsSection = z
  .object({
    /** Registry alias used when no routing rule matches. */
    default: z.string().min(1),
    /** alias -> provider entry. */
    registry: z.record(z.string().min(1), modelEntrySchema),
    routing: z.array(routingRuleSchema),
    /**
     * DESIGN §7: price table per **concrete model id**, not per alias —
     * hardcoding it makes the stats worthless the day prices change.
     */
    prices: z.record(z.string().min(1), unitPricesSchema),
  })
  .strict();

const promptsSection = z
  .object({
    /** Part of every chunk cache key and every reported event (DESIGN §7, §11). */
    version: z.string().min(1),
  })
  .strict();

const limitsSection = z
  .object({
    /** DESIGN §7: checked with `count_tokens` before every call. */
    maxInputTokens: positiveInt,
    /** DESIGN §7: **one** threshold, applied recursively. Not two. */
    compactThreshold: positiveInt,
    /** DESIGN §2: hard-capped at 500; config may lower it, never raise it. */
    maxMessagesPerRange: positiveInt.max(MAX_RANGE_MESSAGES_HARD_CAP),
    /** DESIGN §2: default range when none is given. */
    defaultRangeDays: positiveInt,
    /** DESIGN §8: the reduce step is instructed to stay under this. */
    maxOutputChars: positiveInt,
    /** DESIGN §8: splitting is a safety net — 2–3 parts maximum. */
    maxOutputParts: z.int().min(1).max(3),
  })
  .strict();

const guardsSection = z
  .object({
    /** DESIGN §9: 1 call / 60s per user, replies with remaining seconds. */
    cooldownSeconds: positiveInt,
    /** DESIGN §9: 1 in-flight per chat; also stops two map-reduce jobs racing. */
    concurrentPerChat: positiveInt,
    /** DESIGN §9: identical request within ~5 min returns the previous answer. */
    dedupeTtlSeconds: positiveInt,
    dailyCallsPerChat: positiveInt,
    /** DESIGN §9: the only control that bounds actual liability. A hard stop. */
    globalDailyBudgetUsd: nonNegativeNumber,
  })
  .strict();

const deliverySection = z
  .object({
    /** DESIGN §8: ~1 edit / 3s — edits count against the same 20/min budget. */
    editThrottleMs: positiveInt,
    /** DESIGN §6.5: link previews off. Present as a knob, expected to stay false. */
    linkPreview: z.boolean(),
    /** DESIGN §8: in-chat by default; `/tldr dm on` is a per-user opt-in. */
    dmByDefault: z.boolean(),
  })
  .strict();

const safetySection = z
  .object({
    /**
     * DESIGN §6.6: substitution applied to *rendered output* — a regex, not a
     * prompt rule, so it is testable. Keyed by language code so a third
     * language is additive.
     */
    slurs: z.record(z.string().min(1), z.array(z.string().min(1))),
    redaction: z
      .object({
        /** DESIGN §6.2: secret shapes are stored as `[redacted]` at ingest. */
        enabled: z.boolean(),
        /** Extra shapes beyond the built-ins, as regex sources. */
        extraPatterns: z.array(
          z.object({ name: z.string().min(1), pattern: z.string().min(1) }).strict(),
        ),
      })
      .strict(),
  })
  .strict();

const observabilitySection = z
  .object({
    /** Env `GLITCHTIP_DSN`. Unset selects the no-op reporter (DESIGN §11). */
    dsn: z.string().nullable(),
    /** Tag on every event (DESIGN §11). */
    environment: z.enum(['dev', 'preprod', 'prod', 'test']),
    /** Git SHA, tagged as `release`. Env `RELEASE`. */
    release: z.string().nullable(),
  })
  .strict();

const loggingSection = z
  .object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    /** DESIGN §5: never log row contents. Kept as an explicit, auditable knob. */
    logMessageContents: z.literal(false),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* The whole thing                                                            */
/* -------------------------------------------------------------------------- */

/** The resolved snapshot: every key present, every value valid. */
export const resolvedConfigSchema = z
  .object({
    bot: botSection,
    telegram: telegramSection,
    database: databaseSection,
    retention: retentionSection,
    timezone: timezoneSection,
    models: modelsSection,
    prompts: promptsSection,
    limits: limitsSection,
    guards: guardsSection,
    delivery: deliverySection,
    safety: safetySection,
    observability: observabilitySection,
    logging: loggingSection,
  })
  .strict();

export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;

/** Top-level section names, for `__inspect` paths and for tests. */
export type ConfigSection = keyof ResolvedConfig;

/**
 * One layer's contribution. Every section is optional, and within a section
 * every key is optional: a layer says only what it overrides.
 */
export const configLayerSchema = z
  .object({
    bot: botSection.partial().optional(),
    telegram: telegramSection.partial().optional(),
    database: databaseSection.partial().optional(),
    retention: retentionSection.partial().optional(),
    timezone: timezoneSection.partial().optional(),
    models: modelsSection.partial().optional(),
    prompts: promptsSection.partial().optional(),
    limits: limitsSection.partial().optional(),
    guards: guardsSection.partial().optional(),
    delivery: deliverySection.partial().optional(),
    safety: safetySection.partial().optional(),
    observability: observabilitySection.partial().optional(),
    logging: loggingSection.partial().optional(),
  })
  .strict();

export type ConfigLayer = z.infer<typeof configLayerSchema>;

/**
 * Layer 2 — `config.yaml`.
 *
 * Same shape as any layer, minus the secrets: DESIGN §10 puts `BOT_TOKEN` and
 * the GlitchTip DSN in the env layer only, and `config.yaml` is in git. A
 * secret appearing here is a validation failure, not a warning.
 */
export const fileLayerSchema = configLayerSchema.superRefine((layer, ctx) => {
  if (layer.telegram?.token !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['telegram', 'token'],
      message: 'the bot token is env-only (BOT_TOKEN); config.yaml is in git',
    });
  }
  if (layer.observability?.dsn !== undefined && layer.observability.dsn !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['observability', 'dsn'],
      message: 'the GlitchTip DSN is env-only (GLITCHTIP_DSN)',
    });
  }
  if (layer.telegram?.operatorUserIds !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['telegram', 'operatorUserIds'],
      message: 'operator ids are env-only (OPERATOR_USER_IDS)',
    });
  }
});

/**
 * Layer 4 — per-chat, from SQLite (DESIGN §10).
 *
 * A chat override is not a special mechanism: it is a layer that happens to
 * carry exactly two keys, handed to `__derive`.
 */
export const chatLayerSchema = z
  .object({
    timezone: timezoneSection.partial().optional(),
    models: z.object({ default: z.string().min(1) }).partial().optional(),
  })
  .strict();

export type ChatLayer = z.infer<typeof chatLayerSchema>;

/** Turns a `chat_settings` row into the `chat` layer. Absent values override nothing. */
export function chatLayerFromSettings(settings: ChatSettings | null): ChatLayer {
  if (settings === null) return {};
  const layer: { timezone?: { default: string }; models?: { default: string } } = {};
  if (settings.tz !== null) layer.timezone = { default: settings.tz };
  if (settings.modelAlias !== null) layer.models = { default: settings.modelAlias };
  return layer;
}

/* -------------------------------------------------------------------------- */
/* Layer 3 — env                                                              */
/* -------------------------------------------------------------------------- */

/** The environment as it arrives: strings, or missing. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

const csvInts = (raw: string): number[] =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part));

/**
 * The env vars DESIGN §10 assigns to layer 3. Everything is optional here so
 * that *all* problems are reported at once by `crossValidateResolved` with a
 * readable path, rather than one exception per missing variable.
 */
export const envLayerSchema = z
  .object({
    BOT_TOKEN: z.string().min(1).optional(),
    DATABASE_PATH: z.string().min(1).optional(),
    DATABASE_LOCK_PATH: z.string().min(1).optional(),
    OPERATOR_USER_IDS: z.string().optional(),
    TTL_HARD_CAP_DAYS: z.coerce.number().int().positive().optional(),
    GLITCHTIP_DSN: z.string().optional(),
    ENVIRONMENT: z.enum(['dev', 'preprod', 'prod', 'test']).optional(),
    RELEASE: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  })
  .loose();

export type EnvLayerInput = z.infer<typeof envLayerSchema>;

/** Projects validated env vars onto config paths. Provider API keys are *not* here:
 *  they are referenced by name from `models.registry[*].apiKeyEnv` and read at use. */
export function envLayerFromEnv(env: EnvSource): ConfigLayer {
  const parsed = envLayerSchema.parse(env);
  const layer: ConfigLayer = {};
  const telegram: { token?: string; operatorUserIds?: number[] } = {};
  if (parsed.BOT_TOKEN !== undefined) telegram.token = parsed.BOT_TOKEN;
  if (parsed.OPERATOR_USER_IDS !== undefined) {
    telegram.operatorUserIds = csvInts(parsed.OPERATOR_USER_IDS);
  }
  if (Object.keys(telegram).length > 0) Object.assign(layer, { telegram });

  const database: { path?: string; lockPath?: string } = {};
  if (parsed.DATABASE_PATH !== undefined) database.path = parsed.DATABASE_PATH;
  if (parsed.DATABASE_LOCK_PATH !== undefined) database.lockPath = parsed.DATABASE_LOCK_PATH;
  if (Object.keys(database).length > 0) Object.assign(layer, { database });

  if (parsed.TTL_HARD_CAP_DAYS !== undefined) {
    Object.assign(layer, { retention: { hardCapDays: parsed.TTL_HARD_CAP_DAYS } });
  }

  const observability: { dsn?: string | null; environment?: EnvLayerInput['ENVIRONMENT']; release?: string | null } = {};
  if (parsed.GLITCHTIP_DSN !== undefined) {
    observability.dsn = parsed.GLITCHTIP_DSN.length > 0 ? parsed.GLITCHTIP_DSN : null;
  }
  if (parsed.ENVIRONMENT !== undefined) observability.environment = parsed.ENVIRONMENT;
  if (parsed.RELEASE !== undefined) observability.release = parsed.RELEASE;
  if (Object.keys(observability).length > 0) Object.assign(layer, { observability });

  if (parsed.LOG_LEVEL !== undefined) {
    Object.assign(layer, { logging: { level: parsed.LOG_LEVEL } });
  }
  return layer;
}

/* -------------------------------------------------------------------------- */
/* Step 4 — cross-validation of the resolved snapshot (DESIGN §10)            */
/* -------------------------------------------------------------------------- */

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Recursively reports any key using one of the reserved `config-layers` names. */
export function findReservedKeys(value: unknown, path: readonly string[] = []): ConfigIssue[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const issues: ConfigIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (RESERVED_CONFIG_KEYS.includes(key)) {
      issues.push({
        path: here.join('.'),
        message: `"${key}" is reserved by config-layers and cannot be a config key`,
      });
    }
    issues.push(...findReservedKeys(child, here));
  }
  return issues;
}

/**
 * The checks that can only run against the resolved view (DESIGN §10, step 4):
 * every model referenced by a routing rule exists in the registry, every
 * registry entry's `apiKeyEnv` is actually set, every priced model exists.
 *
 * Returns *all* issues rather than throwing on the first, because a config file
 * with three mistakes should report three mistakes.
 */
export function crossValidateResolved(config: ResolvedConfig, env: EnvSource): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const aliases = Object.keys(config.models.registry);
  const modelIds = new Set(Object.values(config.models.registry).map((entry) => entry.model));

  if (config.telegram.token.length === 0) {
    issues.push({ path: 'telegram.token', message: 'BOT_TOKEN is not set' });
  }

  if (aliases.length === 0) {
    issues.push({ path: 'models.registry', message: 'the model registry is empty' });
  }

  if (!Object.hasOwn(config.models.registry, config.models.default)) {
    issues.push({
      path: 'models.default',
      message: `"${config.models.default}" is not in the registry (known: ${aliases.join(', ')})`,
    });
  }

  config.models.routing.forEach((rule, index) => {
    if (!Object.hasOwn(config.models.registry, rule.use)) {
      issues.push({
        path: `models.routing.${String(index)}.use`,
        message: `"${rule.use}" is not in the registry (known: ${aliases.join(', ')})`,
      });
    }
  });

  for (const [alias, entry] of Object.entries(config.models.registry)) {
    const key = env[entry.apiKeyEnv];
    if (key === undefined || key.length === 0) {
      issues.push({
        path: `models.registry.${alias}.apiKeyEnv`,
        message: `environment variable ${entry.apiKeyEnv} is not set`,
      });
    }
    if (!Object.hasOwn(config.models.prices, entry.model)) {
      issues.push({
        path: `models.prices.${entry.model}`,
        message: `no price table entry for model "${entry.model}" (used by alias "${alias}")`,
      });
    }
  }

  for (const pricedModel of Object.keys(config.models.prices)) {
    if (!modelIds.has(pricedModel)) {
      issues.push({
        path: `models.prices.${pricedModel}`,
        message: `priced model "${pricedModel}" is not used by any registry entry`,
      });
    }
  }

  // Retention: nothing may exceed the env-set hard cap (DESIGN §5).
  if (config.retention.ttlDays > config.retention.hardCapDays) {
    issues.push({
      path: 'retention.ttlDays',
      message: `${String(config.retention.ttlDays)}d exceeds the hard cap of ${String(config.retention.hardCapDays)}d`,
    });
  }
  for (const [chatId, days] of Object.entries(config.retention.perChatTtlDays)) {
    if (days > config.retention.hardCapDays) {
      issues.push({
        path: `retention.perChatTtlDays.${chatId}`,
        message: `${String(days)}d exceeds the hard cap of ${String(config.retention.hardCapDays)}d`,
      });
    }
    if (!Number.isSafeInteger(Number(chatId))) {
      issues.push({
        path: `retention.perChatTtlDays.${chatId}`,
        message: 'key must be a chat id',
      });
    }
  }

  // DESIGN §7: one threshold, and it has to sit under the ceiling to be reachable.
  if (config.limits.compactThreshold > config.limits.maxInputTokens) {
    issues.push({
      path: 'limits.compactThreshold',
      message: 'compaction threshold is above maxInputTokens, so compaction can never trigger',
    });
  }

  if (!isValidTimeZone(config.timezone.default)) {
    issues.push({
      path: 'timezone.default',
      message: `"${config.timezone.default}" is not a known IANA time zone`,
    });
  }

  // DESIGN §12: the 👍/👎 keyboard needs callback_query in allowed_updates.
  if (!config.telegram.allowedUpdates.includes('callback_query')) {
    issues.push({
      path: 'telegram.allowedUpdates',
      message: 'callback_query is required or the feedback keyboard spins forever',
    });
  }
  if (!config.telegram.allowedUpdates.includes('message')) {
    issues.push({
      path: 'telegram.allowedUpdates',
      message: 'message is required or there is no corpus',
    });
  }

  if (config.telegram.allowlist.length === 0) {
    issues.push({
      path: 'telegram.allowlist',
      message: 'the allowlist is empty: the bot would refuse and leave every chat',
    });
  }

  issues.push(...findReservedKeys(config));
  return issues;
}
