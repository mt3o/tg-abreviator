import { describe, expect, it } from 'vitest';

import { UnknownModelError } from '../../domain/errors.js';
import { findByModelId, requireByModelId, resolveAlias } from './registry.js';
import type { ModelRegistry } from './registry.js';

const REGISTRY: ModelRegistry = {
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
};

describe('resolveAlias', () => {
  it('resolves a known alias to its registry entry', () => {
    const resolved = resolveAlias(REGISTRY, 'haiku');
    expect(resolved.alias).toBe('haiku');
    expect(resolved.entry.model).toBe('claude-haiku-4-5');
  });

  it('throws UnknownModelError for an alias not in the registry', () => {
    expect(() => resolveAlias(REGISTRY, 'opus')).toThrow(UnknownModelError);
    try {
      resolveAlias(REGISTRY, 'opus');
      expect.unreachable('expected UnknownModelError');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      expect((error as UnknownModelError).alias).toBe('opus');
    }
  });
});

describe('findByModelId / requireByModelId', () => {
  it('finds the registry entry for a concrete model id — the reverse lookup an Llm adapter needs', () => {
    const found = findByModelId(REGISTRY, 'claude-sonnet-5');
    expect(found?.alias).toBe('sonnet');
  });

  it('returns null, not a throw, when nothing matches', () => {
    expect(findByModelId(REGISTRY, 'claude-opus-9000')).toBeNull();
  });

  it('requireByModelId throws UnknownModelError for the same case', () => {
    expect(() => requireByModelId(REGISTRY, 'claude-opus-9000')).toThrow(UnknownModelError);
  });
});
