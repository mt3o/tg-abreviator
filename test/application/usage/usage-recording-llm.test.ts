import { describe, expect, it } from 'vitest';

import { runWithUsageContext } from '../../../src/application/usage/call-context.js';
import { UsageRecordingLlm } from '../../../src/application/usage/usage-recording-llm.js';
import { asChatId, asThreadId, asUserId } from '../../../src/domain/model/ids.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeIdGenerator } from '../../fakes/fake-id-generator.js';
import { FakeLlm } from '../../fakes/fake-llm.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';
import type { LlmRequest, OutputContract } from '../../../src/application/ports/driven/llm.js';
import type { UsageCallContext } from '../../../src/application/usage/call-context.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const THREAD_ID = asThreadId(7);
const USER_ID = asUserId(111);

const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

const OUTPUT: OutputContract<{ ok: true }> = {
  name: 'test-output',
  jsonSchema: {},
  parse: () => ({ ok: true }),
};

function request(overrides: Partial<LlmRequest<{ ok: true }>> = {}): LlmRequest<{ ok: true }> {
  return {
    model: 'claude-sonnet-5',
    system: 'be helpful',
    userBlocks: [{ kind: 'transcript', text: 'hello' }],
    output: OUTPUT,
    maxOutputTokens: 100,
    phase: 'single',
    ...overrides,
  };
}

function context(overrides: Partial<UsageCallContext> = {}): UsageCallContext {
  return {
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
    rangeSpec: '2h',
    question: null,
    ...overrides,
  };
}

function build() {
  const inner = new FakeLlm();
  const usage = new FakeUsageStore();
  const clock = new FakeClock();
  const idGenerator = new FakeIdGenerator();
  const llm = new UsageRecordingLlm({
    inner,
    usage,
    clock,
    idGenerator,
    priceFor: () => PRICES,
  });
  return { inner, usage, clock, idGenerator, llm };
}

describe('UsageRecordingLlm.complete', () => {
  it('records a usage_events row when called inside a usage context', async () => {
    const { inner, usage, llm } = build();
    inner.enqueue({ raw: { ok: true }, usage: { inputTokens: 500, outputTokens: 50 } });

    await runWithUsageContext(context(), async () => await llm.complete(request()));

    const rows = usage.dump(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(500);
    expect(rows[0]?.outputTokens).toBe(50);
    expect(rows[0]?.status).toBe('ok');
    expect(rows[0]?.phase).toBe('single');
  });

  it('still returns the underlying response unchanged', async () => {
    const { inner, llm } = build();
    inner.enqueue({ raw: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } });

    const response = await runWithUsageContext(context(), async () => await llm.complete(request()));
    expect(response.structured).toEqual({ ok: true });
  });

  it('computes cost from the priced tokens using priceFor(model)', async () => {
    const { inner, usage, llm } = build();
    inner.enqueue({ raw: { ok: true }, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });

    await runWithUsageContext(context(), async () => await llm.complete(request()));
    expect(usage.dump(CHAT_ID)[0]?.costMicros).toBe(3_000_000 + 15_000_000);
  });

  it('records the map-phase model, distinct from a later reduce-phase call, across two calls in one context', async () => {
    const { inner, usage, llm } = build();
    inner.enqueue(
      { raw: { ok: true }, usage: { inputTokens: 10, outputTokens: 10 } },
      { raw: { ok: true }, usage: { inputTokens: 20, outputTokens: 20 } },
    );

    await runWithUsageContext(context(), async () => {
      await llm.complete(request({ phase: 'map', model: 'claude-haiku-4-5' }));
      await llm.complete(request({ phase: 'reduce', model: 'claude-sonnet-5' }));
    });

    const rows = usage.dump(CHAT_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.phase)).toEqual(['map', 'reduce']);
    expect(rows.map((r) => r.model)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it('records nothing when called with no usage context active', async () => {
    const { inner, usage, llm } = build();
    inner.enqueue({ raw: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } });

    await llm.complete(request());
    expect(usage.knownChatIds()).toHaveLength(0);
  });

  it('records an error-status row and rethrows when the inner call fails', async () => {
    const { inner, usage, llm } = build();
    const boom = new Error('provider exploded');
    inner.enqueue({ raw: null, error: boom });

    await expect(
      runWithUsageContext(context(), async () => await llm.complete(request())),
    ).rejects.toBe(boom);

    const rows = usage.dump(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.costMicros).toBe(0);
  });

  it('never stores the question text, only its hash, even though it flowed through the context', async () => {
    const { inner, usage, llm } = build();
    inner.enqueue({ raw: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } });

    await runWithUsageContext(context({ question: 'co ustalili w sprawie budżetu?' }), async () => {
      await llm.complete(request());
    });

    const [row] = usage.dump(CHAT_ID);
    expect(row?.questionHash).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain('budżetu');
  });

  it('isolates context across two concurrent invocations for different chats', async () => {
    const { inner, usage, llm } = build();
    const otherChat = asChatId(-2);
    inner.enqueue(
      { raw: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } },
      { raw: { ok: true }, usage: { inputTokens: 2, outputTokens: 2 } },
    );

    await Promise.all([
      runWithUsageContext(context({ chatId: CHAT_ID }), async () => {
        await llm.complete(request());
      }),
      runWithUsageContext(context({ chatId: otherChat }), async () => {
        await llm.complete(request());
      }),
    ]);

    expect(usage.dump(CHAT_ID)).toHaveLength(1);
    expect(usage.dump(otherChat)).toHaveLength(1);
  });
});

describe('UsageRecordingLlm.countTokens', () => {
  it('records a zero-cost count_tokens row for the audit trail (DESIGN §7)', async () => {
    const { usage, llm } = build();

    await runWithUsageContext(context(), async () => {
      await llm.countTokens({ model: 'claude-sonnet-5', system: 'sys', userBlocks: [] });
    });

    const [row] = usage.dump(CHAT_ID);
    expect(row?.phase).toBe('count_tokens');
    expect(row?.costMicros).toBe(0);
  });

  it('still returns the real count from the inner Llm', async () => {
    const { llm } = build();
    const count = await runWithUsageContext(context(), async () =>
      await llm.countTokens({ model: 'claude-sonnet-5', system: 'four', userBlocks: [] }),
    );
    expect(count).toBeGreaterThan(0);
  });
});
