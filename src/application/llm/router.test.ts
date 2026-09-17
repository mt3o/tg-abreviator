import { describe, expect, it } from 'vitest';

import { asChatId } from '../../domain/model/ids.js';
import { UnknownModelError } from '../../domain/errors.js';
import { crossValidateResolved, resolvedConfigSchema } from '../../config/schema.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { routeModel, selectAlias } from './router.js';
import type { ModelsConfig } from './registry.js';
import type { RouteContext, RoutingRule } from './router.js';

const CHAT_A = asChatId(-1001);
const CHAT_B = asChatId(-1002);

const REGISTRY: ModelsConfig['registry'] = {
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
  premium: {
    provider: 'anthropic',
    model: 'claude-opus-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    maxOutputTokens: 4096,
  },
};

function models(routing: readonly RoutingRule[]): ModelsConfig {
  return {
    default: 'sonnet',
    registry: REGISTRY,
    routing: [...routing],
    prices: {},
  };
}

describe('selectAlias — DESIGN §7: ordered [{when, use}] rule list, first match wins, plus a default', () => {
  const cases: {
    readonly name: string;
    readonly routing: readonly RoutingRule[];
    readonly ctx: RouteContext;
    readonly expected: string;
  }[] = [
    {
      name: 'no rules at all -> default',
      routing: [],
      ctx: { phase: 'single', chatId: CHAT_A },
      expected: 'sonnet',
    },
    {
      name: 'phase-only rule matches on phase',
      routing: [{ when: { phase: 'map' }, use: 'haiku' }],
      ctx: { phase: 'map', chatId: CHAT_A },
      expected: 'haiku',
    },
    {
      name: "phase-only rule does not match a different phase -> falls through to default",
      routing: [{ when: { phase: 'map' }, use: 'haiku' }],
      ctx: { phase: 'reduce', chatId: CHAT_A },
      expected: 'sonnet',
    },
    {
      name: 'chatId-only rule matches the named chat',
      routing: [{ when: { chatId: -1001 }, use: 'premium' }],
      ctx: { phase: 'single', chatId: CHAT_A },
      expected: 'premium',
    },
    {
      name: 'chatId-only rule does not match a different chat',
      routing: [{ when: { chatId: -1001 }, use: 'premium' }],
      ctx: { phase: 'single', chatId: CHAT_B },
      expected: 'sonnet',
    },
    {
      name: 'minInputTokens rule matches once the pre-flight count clears the threshold',
      routing: [{ when: { minInputTokens: 50_000 }, use: 'haiku' }],
      ctx: { phase: 'single', chatId: CHAT_A, inputTokens: 60_000 },
      expected: 'haiku',
    },
    {
      name: 'minInputTokens rule does not match below the threshold',
      routing: [{ when: { minInputTokens: 50_000 }, use: 'haiku' }],
      ctx: { phase: 'single', chatId: CHAT_A, inputTokens: 10_000 },
      expected: 'sonnet',
    },
    {
      name: 'minInputTokens rule does not match when the count is unknown',
      routing: [{ when: { minInputTokens: 50_000 }, use: 'haiku' }],
      ctx: { phase: 'single', chatId: CHAT_A },
      expected: 'sonnet',
    },
    {
      name: 'a rule combining phase + chatId requires both to hold',
      routing: [{ when: { phase: 'map', chatId: -1001 }, use: 'premium' }],
      ctx: { phase: 'map', chatId: CHAT_B },
      expected: 'sonnet',
    },
    {
      name: 'first match wins over a later rule that would also match',
      routing: [
        { when: { phase: 'map' }, use: 'haiku' },
        { when: {}, use: 'premium' },
      ],
      ctx: { phase: 'map', chatId: CHAT_A },
      expected: 'haiku',
    },
    {
      name: 'an earlier non-matching rule is skipped in favour of a later match',
      routing: [
        { when: { phase: 'reduce' }, use: 'premium' },
        { when: { phase: 'map' }, use: 'haiku' },
      ],
      ctx: { phase: 'map', chatId: CHAT_A },
      expected: 'haiku',
    },
    {
      name: 'DESIGN §7 default routing: map phase on the cheap model',
      routing: [{ when: { phase: 'map' }, use: 'haiku' }],
      ctx: { phase: 'map', chatId: CHAT_A },
      expected: 'haiku',
    },
  ];

  for (const { name, routing, ctx, expected } of cases) {
    it(name, () => {
      expect(selectAlias(models(routing), ctx)).toBe(expected);
    });
  }
});

describe('routeModel', () => {
  it('resolves all the way to a concrete registry entry', () => {
    const resolved = routeModel(models([{ when: { phase: 'map' }, use: 'haiku' }]), {
      phase: 'map',
      chatId: CHAT_A,
    });
    expect(resolved.alias).toBe('haiku');
    expect(resolved.entry.model).toBe('claude-haiku-4-5');
  });

  it('throws UnknownModelError when the selected alias is not in the registry — a stale hand-built config, never a validated one', () => {
    const bad = models([{ when: { phase: 'map' }, use: 'does-not-exist' }]);
    expect(() => routeModel(bad, { phase: 'map', chatId: CHAT_A })).toThrow(UnknownModelError);
  });
});

describe('config load validates routing before the router ever runs (DESIGN §10 step 4)', () => {
  it('every RoutablePhase value the router understands is accepted by the resolved config schema', () => {
    for (const phase of ['single', 'map', 'reduce'] as const) {
      const merged = {
        ...DEFAULT_CONFIG,
        telegram: { ...DEFAULT_CONFIG.telegram, token: 'test-token' },
        models: { ...DEFAULT_CONFIG.models, routing: [{ when: { phase }, use: 'haiku' }] },
      };
      expect(() => resolvedConfigSchema.parse(merged)).not.toThrow();
    }
  });

  it('a routing rule naming an unknown model fails cross-validation at load, before Llm.complete() ever sees it', () => {
    const merged = {
      ...DEFAULT_CONFIG,
      telegram: { ...DEFAULT_CONFIG.telegram, token: 'test-token' },
      models: {
        ...DEFAULT_CONFIG.models,
        routing: [{ when: { phase: 'map' as const }, use: 'does-not-exist' }],
      },
    };
    const resolved = resolvedConfigSchema.parse(merged);
    const issues = crossValidateResolved(resolved, { ANTHROPIC_API_KEY: 'test-key' });

    expect(issues).toContainEqual(
      expect.objectContaining({
        path: 'models.routing.0.use',
        message: expect.stringContaining('does-not-exist'),
      }),
    );
  });
});
