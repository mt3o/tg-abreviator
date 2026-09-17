import { describe, expect, it } from 'vitest';

import { Temporal } from '../time/temporal.js';
import { asChatId, asThreadId } from '../model/ids.js';
import type { RangeSpec, ResolvedRange } from '../model/range.js';
import { ALL_TOPICS, threadScope } from '../model/scope.js';
import type { AnswerMeta } from '../model/answer.js';
import { buildHeader } from './header.js';

const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');

function resolvedRange(spec: RangeSpec, overrides: Partial<ResolvedRange> = {}): ResolvedRange {
  return {
    scope: threadScope(null),
    start: { kind: 'instant', ts: NOW.subtract({ hours: 2 }) },
    end: NOW,
    limit: 500,
    spec,
    basis: 'explicit',
    clampedToHorizon: false,
    timeZone: 'Europe/Warsaw',
    ...overrides,
  };
}

function baseMeta(overrides: Partial<AnswerMeta> = {}): AnswerMeta {
  const spec: RangeSpec = { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } };
  return {
    chatId: asChatId(-1001),
    scope: threadScope(null),
    topicLabel: null,
    range: resolvedRange(spec),
    spec,
    messageCount: 43,
    gapCount: 0,
    cached: null,
    model: 'claude-sonnet-5',
    promptVersion: 'v1',
    ...overrides,
  };
}

describe('buildHeader', () => {
  it('matches the DESIGN §2 shape: "Topic: Deploys · last 2h · 43 messages"', () => {
    const threadId = asThreadId(7);
    const header = buildHeader(
      baseMeta({ scope: threadScope(threadId), topicLabel: 'Deploys' }),
      'neutral',
      'en',
    );
    expect(header).toBe('<b>Topic: Deploys · last 2h · 43 messages</b>');
  });

  it('omits the topic segment entirely for a non-forum / General chat', () => {
    const header = buildHeader(baseMeta({ scope: threadScope(null) }), 'neutral', 'en');
    expect(header).toBe('<b>last 2h · 43 messages</b>');
  });

  it('labels the "all topics" scope', () => {
    const header = buildHeader(baseMeta({ scope: ALL_TOPICS }), 'neutral', 'en');
    expect(header).toContain('All topics');
  });

  it('escapes an untrusted topic label rather than trusting it as HTML', () => {
    const header = buildHeader(
      baseMeta({ scope: threadScope(asThreadId(1)), topicLabel: '<script>x</script>' }),
      'neutral',
      'en',
    );
    expect(header).not.toContain('<script>');
    expect(header).toContain('&lt;script&gt;');
  });

  it('prefixes a heated tone with a warning emoji (DESIGN §6.6)', () => {
    const header = buildHeader(baseMeta(), 'heated', 'en');
    expect(header.startsWith('<b>⚠️ ')).toBe(true);
  });

  it('does not warn for a neutral tone', () => {
    const header = buildHeader(baseMeta(), 'neutral', 'en');
    expect(header).not.toContain('⚠️');
  });

  it('adds the cached marker line (DESIGN §9)', () => {
    const header = buildHeader(baseMeta({ cached: { ageMinutes: 4 } }), 'neutral', 'en');
    expect(header).toContain('↺ answered 4 min ago');
  });

  it('adds a gap disclosure line, singular vs. plural (DESIGN §4)', () => {
    const one = buildHeader(baseMeta({ gapCount: 1 }), 'neutral', 'en');
    expect(one).toContain('⚠️ 1 gap in the log');
    const many = buildHeader(baseMeta({ gapCount: 3 }), 'neutral', 'en');
    expect(many).toContain('⚠️ 3 gaps in the log');
  });

  it('says nothing about gaps when there are none', () => {
    const header = buildHeader(baseMeta({ gapCount: 0 }), 'neutral', 'en');
    expect(header).not.toContain('gap');
  });

  it('renders the Polish equivalents', () => {
    const threadId = asThreadId(7);
    const header = buildHeader(
      baseMeta({ scope: threadScope(threadId), topicLabel: 'Wdrożenia', cached: { ageMinutes: 2 }, gapCount: 1 }),
      'neutral',
      'pl',
    );
    expect(header).toContain('Wątek: Wdrożenia');
    expect(header).toContain('ostatnie 2h');
    expect(header).toContain('43 wiadomości');
    expect(header).toContain('↺ odpowiedź sprzed 2 min');
    expect(header).toContain('⚠️ 1 przerwa w logu');
  });
});
