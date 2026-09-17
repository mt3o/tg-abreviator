import { describe, expect, it } from 'vitest';

import { formatUsageStats } from './format-stats.js';
import { Temporal } from '../../domain/time/temporal.js';
import { asChatId } from '../../domain/model/ids.js';
import type { UsageSummary } from '../../domain/model/usage.js';
import type { ReadUsageResult } from '../ports/driving/read-usage.js';

const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const CHAT_ID = asChatId(-1_000_000_000_001);

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    calls: 3,
    inputTokens: 3000,
    outputTokens: 900,
    costMicros: 21_500,
    since: NOW.subtract({ hours: 1 }),
    until: NOW,
    byModel: {
      'claude-sonnet-5': { calls: 2, inputTokens: 2500, outputTokens: 800, costMicros: 20_000 },
      'claude-haiku-4-5': { calls: 1, inputTokens: 500, outputTokens: 100, costMicros: 1_500 },
    },
    ...overrides,
  };
}

function result(overrides: Partial<ReadUsageResult> = {}): ReadUsageResult {
  return {
    scope: { kind: 'chat', chatId: CHAT_ID },
    summary: summary(),
    budgetRemainingMicros: 4_000_000,
    ...overrides,
  };
}

describe('formatUsageStats', () => {
  it('includes the call count, token total and cost', () => {
    const text = formatUsageStats(result(), 'en');
    expect(text).toContain('3 calls');
    expect(text).toContain('3900 tokens');
    expect(text).toContain('$0.0215');
  });

  it('labels a chat-scoped result distinctly from a global one', () => {
    const chatText = formatUsageStats(result({ scope: { kind: 'chat', chatId: CHAT_ID } }), 'en');
    const globalText = formatUsageStats(result({ scope: { kind: 'global' } }), 'en');
    expect(chatText).toContain('This chat');
    expect(globalText).toContain('All chats');
  });

  it('breaks costs down by model', () => {
    const text = formatUsageStats(result(), 'en');
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('claude-haiku-4-5');
  });

  it('shows remaining budget headroom when positive', () => {
    const text = formatUsageStats(result({ budgetRemainingMicros: 2_500_000 }), 'en');
    expect(text).toContain('$2.5');
    expect(text).toContain('remaining');
  });

  it('shows the budget is exhausted rather than a negative dollar figure', () => {
    const text = formatUsageStats(result({ budgetRemainingMicros: -500_000 }), 'en');
    expect(text).not.toContain('-$');
    expect(text.toLowerCase()).toContain('exhausted');
  });

  it('omits the budget line entirely when budgetRemainingMicros is null', () => {
    const text = formatUsageStats(result({ budgetRemainingMicros: null }), 'en');
    expect(text.toLowerCase()).not.toContain('budget');
  });

  it('renders in Polish when asked', () => {
    const text = formatUsageStats(result(), 'pl');
    expect(text).toContain('Ten czat');
    expect(text).toContain('wywoła');
  });

  it('handles a summary with zero calls and no per-model breakdown', () => {
    const empty = result({
      summary: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        since: NOW.subtract({ hours: 1 }),
        until: NOW,
        byModel: {},
      },
    });
    const text = formatUsageStats(empty, 'en');
    expect(text).toContain('0 calls');
    expect(text).not.toContain('By model');
  });
});
