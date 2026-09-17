/**
 * The configuration contract (DESIGN §10).
 *
 * `config-layers` does not validate at runtime, so these schemas are the only
 * thing standing between an untyped YAML file and a bot that boots with a
 * routing rule naming a model that does not exist.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import {
  RESERVED_CONFIG_KEYS,
  chatLayerFromSettings,
  crossValidateResolved,
  envLayerFromEnv,
  fileLayerSchema,
  findReservedKeys,
  resolvedConfigSchema,
} from '../../src/config/schema.js';
import type { ResolvedConfig } from '../../src/config/schema.js';
import { deepMerge } from '../fakes/fake-config.js';
import type { Plain } from '../fakes/fake-config.js';
import { CHAT_A, USER_ALA, at } from '../conformance/support.js';

const ENV_WITH_KEYS = {
  BOT_TOKEN: '123456:abcdef',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPERATOR_USER_IDS: '11, 22',
};

function resolve(...layers: Plain[]): ResolvedConfig {
  let merged: Plain = {};
  for (const layer of layers) merged = deepMerge(merged, layer);
  return resolvedConfigSchema.parse(merged);
}

/** Everything the defaults deliberately leave to the operator. */
const OPERATOR_LAYER: Plain = {
  telegram: { allowlist: [-1000000000001] },
  bot: { operatorContact: '@operator' },
};

describe('defaults layer', () => {
  it('needs only an allowlist, a token and a key to become a valid config', () => {
    const resolved = resolve(
      DEFAULT_CONFIG as Plain,
      OPERATOR_LAYER,
      envLayerFromEnv(ENV_WITH_KEYS) as Plain,
    );
    expect(crossValidateResolved(resolved, ENV_WITH_KEYS)).toEqual([]);
  });

  it('routes the map phase to the cheap model (DESIGN §7)', () => {
    expect(DEFAULT_CONFIG.models.routing[0]).toEqual({ when: { phase: 'map' }, use: 'haiku' });
    expect(DEFAULT_CONFIG.models.default).toBe('sonnet');
  });

  it('cannot express a range above the hard cap', () => {
    expect(DEFAULT_CONFIG.limits.maxMessagesPerRange).toBeLessThanOrEqual(500);
    expect(() =>
      resolvedConfigSchema.parse(
        deepMerge(
          deepMerge(DEFAULT_CONFIG as Plain, OPERATOR_LAYER),
          deepMerge(envLayerFromEnv(ENV_WITH_KEYS) as Plain, {
            limits: { maxMessagesPerRange: 5000 },
          }),
        ),
      ),
    ).toThrow();
  });
});

describe('config.example.yaml', () => {
  const raw: unknown = YAML.parse(readFileSync('config.example.yaml', 'utf8'));

  it('is a valid file layer', () => {
    const parsed = fileLayerSchema.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  it('resolves and cross-validates once the env layer supplies the secrets', () => {
    const resolved = resolve(
      DEFAULT_CONFIG as Plain,
      raw as Plain,
      { telegram: { allowlist: [-1000000000001] } },
      envLayerFromEnv(ENV_WITH_KEYS) as Plain,
    );
    expect(crossValidateResolved(resolved, ENV_WITH_KEYS)).toEqual([]);
  });

  it('documents every section the resolved schema requires', () => {
    const documented = new Set(Object.keys(raw as Plain));
    const required = Object.keys(resolvedConfigSchema.shape);
    expect([...required].filter((section) => !documented.has(section))).toEqual([]);
  });
});

describe('the file layer holds no secrets (DESIGN §10)', () => {
  it('rejects a bot token', () => {
    const parsed = fileLayerSchema.safeParse({ telegram: { token: 'oops' } });
    expect(parsed.success).toBe(false);
  });

  it('rejects a GlitchTip DSN', () => {
    const parsed = fileLayerSchema.safeParse({ observability: { dsn: 'https://x@y/1' } });
    expect(parsed.success).toBe(false);
  });

  it('rejects operator ids', () => {
    const parsed = fileLayerSchema.safeParse({ telegram: { operatorUserIds: [1] } });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown key, because a typo is a silent misconfiguration', () => {
    const parsed = fileLayerSchema.safeParse({ limits: { maxInputTokenz: 10 } });
    expect(parsed.success).toBe(false);
  });
});

describe('env layer', () => {
  it('projects env vars onto config paths', () => {
    const layer = envLayerFromEnv({
      ...ENV_WITH_KEYS,
      DATABASE_PATH: '/data/bot.db',
      TTL_HARD_CAP_DAYS: '14',
      LOG_LEVEL: 'debug',
      GLITCHTIP_DSN: '',
    });
    expect(layer.telegram?.token).toBe('123456:abcdef');
    expect(layer.telegram?.operatorUserIds).toEqual([11, 22]);
    expect(layer.database?.path).toBe('/data/bot.db');
    expect(layer.retention?.hardCapDays).toBe(14);
    expect(layer.logging?.level).toBe('debug');
    // An empty DSN is "no error sink", not a broken one (DESIGN §11).
    expect(layer.observability?.dsn).toBeNull();
  });

  it('says nothing about keys the environment does not set', () => {
    expect(envLayerFromEnv({})).toEqual({});
  });
});

describe('chat layer (DESIGN §10, layer 4)', () => {
  it('overrides only what the chat has actually set', () => {
    expect(
      chatLayerFromSettings({
        chatId: CHAT_A,
        tz: 'Europe/Berlin',
        modelAlias: null,
        updatedBy: USER_ALA,
        updatedAt: at(0),
      }),
    ).toEqual({ timezone: { default: 'Europe/Berlin' } });

    expect(chatLayerFromSettings(null)).toEqual({});
  });

  it('shadows the file and env layers', () => {
    const resolved = resolve(
      DEFAULT_CONFIG as Plain,
      OPERATOR_LAYER,
      envLayerFromEnv(ENV_WITH_KEYS) as Plain,
      chatLayerFromSettings({
        chatId: CHAT_A,
        tz: 'Europe/Berlin',
        modelAlias: 'haiku',
        updatedBy: USER_ALA,
        updatedAt: at(0),
      }) as Plain,
    );
    expect(resolved.timezone.default).toBe('Europe/Berlin');
    expect(resolved.models.default).toBe('haiku');
  });
});

describe('cross-validation of the resolved snapshot (DESIGN §10, step 4)', () => {
  const base = (): Plain =>
    deepMerge(
      deepMerge(DEFAULT_CONFIG as Plain, OPERATOR_LAYER),
      envLayerFromEnv(ENV_WITH_KEYS) as Plain,
    );

  function issuesFor(patch: Plain, env: Record<string, string> = ENV_WITH_KEYS): string[] {
    const resolved = resolvedConfigSchema.parse(deepMerge(base(), patch));
    return crossValidateResolved(resolved, env).map((issue) => issue.path);
  }

  it('catches a routing rule naming a model that is not in the registry', () => {
    expect(issuesFor({ models: { routing: [{ when: { phase: 'map' }, use: 'opus' }] } })).toContain(
      'models.routing.0.use',
    );
  });

  it('catches a default model that is not in the registry', () => {
    expect(issuesFor({ models: { default: 'nope' } })).toContain('models.default');
  });

  it('catches an apiKeyEnv whose environment variable is not set', () => {
    expect(issuesFor({}, { BOT_TOKEN: 't' })).toContain('models.registry.sonnet.apiKeyEnv');
  });

  it('catches a registry model with no price, and a price with no model', () => {
    const paths = issuesFor({
      models: {
        registry: {
          sonnet: {
            provider: 'anthropic',
            model: 'claude-unpriced',
            apiKeyEnv: 'ANTHROPIC_API_KEY',
            maxOutputTokens: 1024,
          },
        },
      },
    });
    expect(paths).toContain('models.prices.claude-unpriced');
    expect(paths).toContain('models.prices.claude-sonnet-5');
  });

  it('catches a TTL above the env-set hard cap (DESIGN §5)', () => {
    expect(issuesFor({ retention: { ttlDays: 400 } })).toContain('retention.ttlDays');
    expect(issuesFor({ retention: { perChatTtlDays: { '-1001': 365 } } })).toContain(
      'retention.perChatTtlDays.-1001',
    );
  });

  it('catches a compaction threshold that can never trigger', () => {
    expect(issuesFor({ limits: { compactThreshold: 200_000 } })).toContain(
      'limits.compactThreshold',
    );
  });

  it('catches an unknown time zone', () => {
    expect(issuesFor({ timezone: { default: 'Mars/Olympus_Mons' } })).toContain(
      'timezone.default',
    );
  });

  it('catches an allowed_updates list that breaks a documented feature', () => {
    expect(issuesFor({ telegram: { allowedUpdates: ['message'] } })).toContain(
      'telegram.allowedUpdates',
    );
  });

  it('catches an empty allowlist, which would make the bot leave every chat', () => {
    expect(issuesFor({ telegram: { allowlist: [] } })).toContain('telegram.allowlist');
  });

  it('reports every problem at once rather than the first', () => {
    const resolved = resolvedConfigSchema.parse(
      deepMerge(base(), { models: { default: 'nope' }, retention: { ttlDays: 400 } }),
    );
    expect(crossValidateResolved(resolved, ENV_WITH_KEYS).length).toBeGreaterThan(1);
  });
});

describe('reserved config-layers names (DESIGN §10)', () => {
  it('rejects a key using a reserved name, at any depth', () => {
    for (const reserved of RESERVED_CONFIG_KEYS) {
      const issues = findReservedKeys({ limits: { nested: { [reserved]: 1 } } });
      expect(issues.map((issue) => issue.path)).toEqual([`limits.nested.${reserved}`]);
    }
  });

  it('finds nothing in the shipped defaults or example file', () => {
    expect(findReservedKeys(DEFAULT_CONFIG)).toEqual([]);
    expect(findReservedKeys(YAML.parse(readFileSync('config.example.yaml', 'utf8')))).toEqual([]);
  });
});
