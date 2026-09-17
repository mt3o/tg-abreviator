/**
 * `Compactor` (DESIGN §7 "Compaction", WS11 DoD).
 *
 * Built entirely against Phase 0's fakes: `FakeLlm`, `FakeChunkStore`,
 * `FakeClock`. `FakeLlm.respond` is used throughout instead of `enqueue()`
 * because several of these tests (the recursion test especially) make far
 * too many calls to script one at a time — the callback inspects
 * `request.output.name` to tell a map/intermediate-reduce call
 * (`chunk_summary_content`) from the final call (`answer_content`) and
 * returns a fixed, minimal, schema-valid payload either way.
 */
import { describe, expect, it } from 'vitest';

import { Compactor } from '../../../src/application/compaction/compactor.js';
import type { CompactionRequest } from '../../../src/application/compaction/types.js';
import { InvalidValueError, EmptyCorpusError } from '../../../src/domain/errors.js';
import { asChatId, asMessageId, asThreadId } from '../../../src/domain/model/ids.js';
import type { ChatId, ThreadId } from '../../../src/domain/model/ids.js';
import type { StoredMessage } from '../../../src/domain/model/message.js';
import { makeMessage, T0 } from '../../conformance/support.js';
import { FakeChunkStore } from '../../fakes/fake-chunk-store.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeLlm } from '../../fakes/fake-llm.js';

const CHAT = asChatId(-1001);
const MAP_MODEL = 'claude-haiku-4-5';
const REDUCE_MODEL = 'claude-sonnet-5';
const PROMPT_VERSION = 'v1';
const ZONE = 'Europe/Warsaw';

/** Exactly 50 characters once `serializeChunkSummary` formats it (see compactor.ts's `nodeWeight`). */
const LEAF_SUMMARY = 'x'.repeat(35);

function scriptedRespond(request: { output: { name: string } }): unknown {
  if (request.output.name === 'chunk_summary_content') {
    return { summary: LEAF_SUMMARY, keyPoints: [], tone: 'neutral' };
  }
  return { summary: 'the final answer', keyPoints: ['a key point'], unanswered: [], tone: 'neutral' };
}

/** `count` messages, each `spacingHours` apart (> the 6h bucket width, so each gets its own bucket). */
function corpus(
  count: number,
  options: { spacingHours?: number; threadId?: ThreadId | null; textLength?: number; chatId?: ChatId } = {},
): StoredMessage[] {
  const spacing = options.spacingHours ?? 7;
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage({
      chatId: options.chatId ?? CHAT,
      messageId: index + 1,
      threadId: options.threadId === undefined ? null : options.threadId,
      ts: T0.add({ hours: spacing * index }),
      text: 'm'.repeat(options.textLength ?? 20),
    }),
  );
}

function makeRequest(overrides: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    chatId: CHAT,
    messages: corpus(10),
    timeZone: ZONE,
    compactThreshold: 800,
    models: { map: MAP_MODEL, reduce: REDUCE_MODEL },
    maxOutputTokens: 1024,
    promptVersion: PROMPT_VERSION,
    language: 'en',
    intent: 'summarize',
    question: null,
    ...overrides,
  };
}

function makeCompactor(options: { llm?: FakeLlm; chunks?: FakeChunkStore; clock?: FakeClock } = {}) {
  const llm = options.llm ?? new FakeLlm();
  llm.respond = scriptedRespond;
  const chunks = options.chunks ?? new FakeChunkStore();
  const clock = options.clock ?? new FakeClock();
  const compactor = new Compactor({ llm, chunks, clock });
  return { compactor, llm, chunks, clock };
}

describe('Compactor — validation', () => {
  it('rejects intent "answer" with no question', async () => {
    const { compactor } = makeCompactor();
    await expect(
      compactor.compact(makeRequest({ intent: 'answer', question: null })),
    ).rejects.toBeInstanceOf(InvalidValueError);
  });

  it('rejects intent "answer" with a blank question', async () => {
    const { compactor } = makeCompactor();
    await expect(
      compactor.compact(makeRequest({ intent: 'answer', question: '   ' })),
    ).rejects.toBeInstanceOf(InvalidValueError);
  });

  it('rejects an empty corpus', async () => {
    const { compactor } = makeCompactor();
    await expect(compactor.compact(makeRequest({ messages: [] }))).rejects.toBeInstanceOf(EmptyCorpusError);
  });
});

describe('Compactor — basic map-reduce', () => {
  it('summarizes a small corpus with no reduce round needed', async () => {
    const { compactor, llm } = makeCompactor();
    // Three buckets, well under the threshold: no reduce round.
    const result = await compactor.compact(makeRequest({ messages: corpus(3), compactThreshold: 100_000 }));

    expect(result.leafChunkCount).toBe(3);
    expect(result.levels).toBe(0);
    expect(result.model).toBe(REDUCE_MODEL);
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.content.summary).toBe('the final answer');

    // Three map calls (cheap model) plus one final reduce call (strong model).
    const mapCalls = result.calls.filter((call) => call.phase === 'map');
    const reduceCalls = result.calls.filter((call) => call.phase === 'reduce');
    expect(mapCalls).toHaveLength(3);
    expect(mapCalls.every((call) => call.model === MAP_MODEL && !call.cached)).toBe(true);
    expect(reduceCalls).toHaveLength(1);
    expect(reduceCalls[0]?.model).toBe(REDUCE_MODEL);
    expect(llm.requests).toHaveLength(4);
    expect(llm.requests.every((r) => r.phase === 'map' || r.phase === 'reduce')).toBe(true);
  });

  it('answers a question in the final call, never in an intermediate one', async () => {
    const { compactor, llm } = makeCompactor();
    await compactor.compact(
      makeRequest({
        messages: corpus(10),
        compactThreshold: 800,
        intent: 'answer',
        question: 'what did we decide?',
      }),
    );

    const finalRequest = llm.requests[llm.requests.length - 1];
    expect(finalRequest?.output.name).toBe('answer_content');
    expect(finalRequest?.userBlocks.some((b) => b.kind === 'question' && b.text === 'what did we decide?')).toBe(
      true,
    );

    // No earlier call ever carries a question block — only the final one answers.
    const earlierRequests = llm.requests.slice(0, -1);
    expect(earlierRequests.every((r) => !r.userBlocks.some((b) => b.kind === 'question'))).toBe(true);
    expect(earlierRequests.every((r) => r.output.name === 'chunk_summary_content')).toBe(true);
  });

  it('performs one reduce round when leaves do not fit in a single final call', async () => {
    const { compactor } = makeCompactor();
    const result = await compactor.compact(makeRequest({ messages: corpus(10), compactThreshold: 800 }));

    expect(result.leafChunkCount).toBe(10);
    expect(result.levels).toBe(1);
    const reduceCalls = result.calls.filter((call) => call.phase === 'reduce');
    // One intermediate reduce call (10 -> 1) plus the final call.
    expect(reduceCalls).toHaveLength(2);
    expect(reduceCalls.every((call) => call.level >= 1)).toBe(true);
  });

  it('never uses the map (cheap) model for a reduce call, or vice versa', async () => {
    const { compactor } = makeCompactor();
    const result = await compactor.compact(makeRequest({ messages: corpus(10), compactThreshold: 800 }));
    for (const call of result.calls) {
      if (call.phase === 'map') expect(call.model).toBe(MAP_MODEL);
      if (call.phase === 'reduce') expect(call.model).toBe(REDUCE_MODEL);
    }
  });
});

describe('Compactor — chunk cache', () => {
  it('a second compaction over the same range reuses every map and intermediate chunk, and only the uncacheable final call runs again', async () => {
    const { compactor, llm, chunks } = makeCompactor();
    const request = makeRequest({ messages: corpus(10), compactThreshold: 800 });

    const first = await compactor.compact(request);
    expect(first.calls.every((call) => !call.cached)).toBe(true);
    const callsAfterFirst = llm.requests.length;

    const second = await compactor.compact(request);
    const cachedCalls = second.calls.filter((call) => call.cached);
    const freshCalls = second.calls.filter((call) => !call.cached);

    // Every map leaf (10) and the one intermediate reduce node are cache hits;
    // only the final (never-cached) call actually reaches the provider.
    expect(cachedCalls).toHaveLength(11);
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.phase).toBe('reduce');
    expect(llm.requests.length).toBe(callsAfterFirst + 1);

    // The chunk store gained exactly 11 rows on the first run (10 leaves + 1
    // intermediate reduce) and gained nothing on the second.
    expect(chunks.dump(CHAT)).toHaveLength(11);
  });

  it('a promptVersion bump misses the cache entirely (WS11 DoD)', async () => {
    const { compactor, chunks } = makeCompactor();
    const request = makeRequest({ messages: corpus(10), compactThreshold: 800, promptVersion: 'v1' });
    await compactor.compact(request);
    expect(chunks.dump(CHAT)).toHaveLength(11);

    const bumped = await compactor.compact({ ...request, promptVersion: 'v2' });
    expect(bumped.calls.every((call) => !call.cached)).toBe(true);
    // A fresh set of chunks was written under the new prompt version, on top
    // of the old ones (the old ones are not deleted — that is the TTL
    // sweeper's job, not the compactor's).
    expect(chunks.dump(CHAT)).toHaveLength(22);
  });

  it('caches by model as well as promptVersion: switching the reduce model misses', async () => {
    const { compactor, chunks } = makeCompactor();
    const request = makeRequest({ messages: corpus(10), compactThreshold: 800 });
    await compactor.compact(request);

    const differentReduceModel = await compactor.compact({
      ...request,
      models: { map: MAP_MODEL, reduce: 'claude-opus-5' },
    });
    // Map leaves are still cached (same map model); the reduce node is not.
    const mapCalls = differentReduceModel.calls.filter((c) => c.phase === 'map');
    const reduceCalls = differentReduceModel.calls.filter((c) => c.phase === 'reduce');
    expect(mapCalls.every((c) => c.cached)).toBe(true);
    expect(reduceCalls.every((c) => !c.cached)).toBe(true);
    expect(chunks.dump(CHAT).some((chunk) => chunk.model === 'claude-opus-5')).toBe(true);
  });
});

describe('Compactor — thread scoping (all-topics ranges)', () => {
  it('keeps leaves from different threads apart and never caches a chunk spanning more than one thread', async () => {
    const threadA = asThreadId(10);
    const threadB = asThreadId(20);
    const messages = [
      ...corpus(3, { threadId: threadA }),
      ...corpus(3, { threadId: threadB }).map((m) => ({ ...m, messageId: asMessageId(m.messageId + 100) })),
    ];
    const { compactor, chunks } = makeCompactor();
    // A low threshold forces a reduce round; with both threads' leaves in one
    // flat node list, a naive grouping could otherwise mix them.
    const result = await compactor.compact(makeRequest({ messages, compactThreshold: 800 }));

    expect(result.leafChunkCount).toBe(6);
    const savedChunks = chunks.dump(CHAT);
    // No saved chunk's [firstMsgId, lastMsgId] can span across the two
    // threads' id ranges (A: 1-3, B: 101-103) while claiming a single
    // threadId — every saved chunk belongs entirely to one side.
    for (const chunk of savedChunks) {
      const spansA = chunk.firstMsgId <= 3;
      const spansB = chunk.lastMsgId >= 101;
      expect(spansA && spansB).toBe(false);
      expect(chunk.threadId === threadA || chunk.threadId === threadB).toBe(true);
    }
  });
});

describe('Compactor — progress reporting', () => {
  it('reports map progress per leaf and reduce progress per round, ending with a 1/1 final report', async () => {
    const reports: { phase: string; level: number; done: number; total: number }[] = [];
    const { compactor } = makeCompactor();
    await compactor.compact(
      makeRequest({
        messages: corpus(10),
        compactThreshold: 800,
        progress: {
          report: (progress) => {
            reports.push({ ...progress });
            return Promise.resolve();
          },
        },
      }),
    );

    const mapReports = reports.filter((r) => r.phase === 'map');
    expect(mapReports).toHaveLength(10);
    expect(mapReports[mapReports.length - 1]).toEqual({ phase: 'map', level: 0, done: 10, total: 10 });

    const finalReport = reports[reports.length - 1];
    expect(finalReport).toEqual({ phase: 'reduce', level: 1, done: 1, total: 1 });
  });
});

describe('Compactor — recursion depth (WS11 DoD: "recursion test reaching depth 3 on a synthetic corpus")', () => {
  it('reaches at least 3 reduce rounds on a large synthetic corpus', async () => {
    const LEAF_COUNT = 20_000;
    // ~400 chars/message * 20,000 messages ≈ 8.3M chars ≈ 2.1M tokens of raw
    // corpus (FakeLlm's chars/4 approximation) — "synthetic 2M-token corpus"
    // per the DoD. The recursion depth itself is driven by the map phase's
    // (fixed-size) scripted output, not by this input size — see
    // `scriptedRespond` — so this is about matching the DoD's scale, not
    // about forcing the recursion.
    const messages = corpus(LEAF_COUNT, { textLength: 400 });
    const { compactor, llm } = makeCompactor();

    const result = await compactor.compact(
      makeRequest({
        messages,
        compactThreshold: 730,
        intent: 'answer',
        question: 'what happened over this huge range?',
      }),
    );

    expect(result.leafChunkCount).toBe(LEAF_COUNT);
    expect(result.levels).toBeGreaterThanOrEqual(3);
    expect(result.content.summary).toBe('the final answer');

    // The tree shrinks strictly at every recorded level, and the final call
    // really is the last one made.
    const reduceLevels = [...new Set(result.calls.filter((c) => c.phase === 'reduce').map((c) => c.level))].sort(
      (a, b) => a - b,
    );
    expect(reduceLevels.length).toBeGreaterThanOrEqual(result.levels);
    expect(llm.requests[llm.requests.length - 1]?.output.name).toBe('answer_content');
  }, 30_000);
});
