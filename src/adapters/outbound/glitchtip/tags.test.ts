import { describe, expect, it } from 'vitest';
import type { ErrorContext } from '../../../application/ports/driven/error-reporter.js';
import { asPseudonymLabel } from '../../../domain/model/pseudonym.js';
import { ALLOWED_TAG_KEYS, buildTags, isAllowedTagKey } from './tags.js';

describe('buildTags', () => {
  it('carries every populated, allowlisted field through as a string', () => {
    const context: ErrorContext = {
      phase: 'llm',
      adapter: 'anthropic',
      chat: asPseudonymLabel('quiet-harbor'),
      user: asPseudonymLabel('kind-otter'),
      inThread: true,
      scopeKind: 'thread',
      intent: 'summarize',
      rangeKind: 'duration',
      llmPhase: 'reduce',
      model: 'claude-strong',
      promptVersion: 'v2',
      messageCount: 340,
      chunkCount: 4,
      compactionDepth: 2,
      inputTokens: 12_000,
      outputTokens: 800,
      httpStatus: 500,
      retryAfterSeconds: 30,
      attempt: 2,
      errorCode: 'llm.provider_error',
      correlationId: 'corr-1',
    };

    const tags = buildTags(context, 'v1');

    expect(tags).toEqual({
      phase: 'llm',
      adapter: 'anthropic',
      chat: 'quiet-harbor',
      user: 'kind-otter',
      inThread: 'true',
      scopeKind: 'thread',
      intent: 'summarize',
      rangeKind: 'duration',
      llmPhase: 'reduce',
      model: 'claude-strong',
      promptVersion: 'v2',
      messageCount: '340',
      chunkCount: '4',
      compactionDepth: '2',
      inputTokens: '12000',
      outputTokens: '800',
      httpStatus: '500',
      retryAfterSeconds: '30',
      attempt: '2',
      errorCode: 'llm.provider_error',
      correlationId: 'corr-1',
    });
  });

  it('omits fields that were never set, rather than sending "undefined"', () => {
    const tags = buildTags({ phase: 'boot' }, 'v1');
    expect(tags).toEqual({ phase: 'boot', promptVersion: 'v1' });
  });

  it('defaults promptVersion when the context did not carry one', () => {
    const tags = buildTags({ phase: 'config' }, 'v7');
    expect(tags.promptVersion).toBe('v7');
  });

  it('lets an explicit promptVersion in context win over the default', () => {
    const tags = buildTags({ phase: 'llm', promptVersion: 'v9' }, 'v7');
    expect(tags.promptVersion).toBe('v9');
  });

  it('only ever emits keys from the allowlist', () => {
    const tags = buildTags(
      { phase: 'llm', model: 'claude-cheap' },
      'v1',
    );
    for (const key of Object.keys(tags)) {
      expect(isAllowedTagKey(key)).toBe(true);
    }
  });
});

describe('isAllowedTagKey', () => {
  it('accepts every declared ErrorContext tag field', () => {
    for (const key of ALLOWED_TAG_KEYS) {
      expect(isAllowedTagKey(key)).toBe(true);
    }
  });

  it('rejects anything not on the list, including near-miss casing', () => {
    expect(isAllowedTagKey('Phase')).toBe(false);
    expect(isAllowedTagKey('displayName')).toBe(false);
    expect(isAllowedTagKey('rawUserId')).toBe(false);
    expect(isAllowedTagKey('question')).toBe(false);
    expect(isAllowedTagKey('text')).toBe(false);
  });
});
