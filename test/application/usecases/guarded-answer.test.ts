/**
 * The guard + billing shell around the answer pipeline (DESIGN §9, §4).
 *
 * The cooldown and dedupe paths are exercised end-to-end in
 * `test/bootstrap/e2e-forum-topic.test.ts`; what is tested here is what that
 * one cannot show cheaply — the budget hard stop, the concurrency slot's
 * release on failure, and the usage context actually being visible to
 * everything running inside one invocation.
 */
import { describe, expect, it } from 'vitest';

import { GuardedPipeline } from '../../../src/application/guards/guarded-pipeline.js';
import { currentUsageContext } from '../../../src/application/usage/call-context.js';
import type { UsageCallContext } from '../../../src/application/usage/call-context.js';
import { GuardedSummarizeRange } from '../../../src/application/usecases/guarded-answer.js';
import type { GuardedAnswerDeps } from '../../../src/application/usecases/guarded-answer.js';
import type { InvocationContext } from '../../../src/application/ports/driving/invocation.js';
import type {
  AnswerOutcome,
  SummarizeRange,
  SummarizeRangeCommand,
} from '../../../src/application/ports/driving/summarize-range.js';
import { asMessageId } from '../../../src/domain/model/ids.js';
import { parse } from '../../../src/domain/range/parse.js';
import { createFakeStores } from '../../fakes/create-fake-stores.js';
import { FakeChatGateway } from '../../fakes/fake-chat-gateway.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeConfig } from '../../fakes/fake-config.js';
import { FakeErrorReporter } from '../../fakes/fake-error-reporter.js';
import { CHAT_A, USER_ALA, makeUsageEvent } from '../../conformance/support.js';

class SpyInner implements SummarizeRange {
  calls = 0;
  readonly contexts: (UsageCallContext | undefined)[] = [];
  failWith: Error | null = null;

  async execute(_command: SummarizeRangeCommand): Promise<AnswerOutcome> {
    this.calls += 1;
    this.contexts.push(currentUsageContext());
    if (this.failWith !== null) throw this.failWith;
    return await Promise.resolve({ kind: 'refused', code: 'corpus.empty' });
  }
}

function makeCase() {
  const clock = new FakeClock();
  const stores = createFakeStores({ clock });
  const config = new FakeConfig();
  const reporter = new FakeErrorReporter();
  const deps: GuardedAnswerDeps = {
    pipeline: new GuardedPipeline({
      clock,
      usage: stores.usage,
      globalUsage: stores.globalUsage,
      errorReporter: reporter,
    }),
    config,
    gateway: new FakeChatGateway(),
    settings: stores.settings,
  };
  const inner = new SpyInner();
  return { ...stores, clock, config, reporter, deps, inner, useCase: new GuardedSummarizeRange(deps, inner) };
}

function command(argString = '-50'): SummarizeRangeCommand {
  const invocation: InvocationContext = {
    chatId: CHAT_A,
    threadId: null,
    invokedMessageId: asMessageId(9000),
    replyToMessageId: null,
    invoker: { userId: USER_ALA, displayName: 'Ala', tier: 'member' },
    rawArgs: argString,
    receivedAt: new FakeClock().now(),
  };
  return { invocation, parsed: parse(argString) };
}

describe('the guarded answer pipeline', () => {
  it('runs the inner use case inside the usage context for the whole invocation', async () => {
    const c = makeCase();

    await c.useCase.execute(command('-50'));

    expect(c.inner.calls).toBe(1);
    expect(c.inner.contexts[0]).toEqual({
      chatId: CHAT_A,
      threadId: null,
      userId: USER_ALA,
      // DESIGN §9: the *raw* token, not the resolved window.
      rangeSpec: '-50',
      question: null,
    });
    // Nothing leaks outside the invocation.
    expect(currentUsageContext()).toBeUndefined();
  });

  it('hard-stops on the global daily budget and tells the operator', async () => {
    const c = makeCase();
    // DESIGN §9: "when the budget trips the bot refuses everything until midnight."
    await c.usage.record(CHAT_A, makeUsageEvent({ costMicros: 6_000_000 }));

    const outcome = await c.useCase.execute(command());

    expect(outcome).toEqual({ kind: 'refused', code: 'guard.budget_exhausted' });
    expect(c.inner.calls).toBe(0);
    // DESIGN §11: budget-cap trips are worth reporting, unlike ordinary refusals.
    expect(c.reporter.reportable().map((event) => event.context.errorCode)).toEqual([
      'guard.budget_exhausted',
    ]);
  });

  it('refuses a per-chat daily cap without touching the model', async () => {
    const c = makeCase();
    const cap = c.config.get('guards').dailyCallsPerChat;
    for (let index = 0; index < cap; index += 1) {
      await c.usage.record(CHAT_A, makeUsageEvent({ id: `usage-${String(index)}`, costMicros: 0 }));
    }

    const outcome = await c.useCase.execute(command());

    expect(outcome).toEqual({ kind: 'refused', code: 'guard.daily_cap' });
    expect(c.inner.calls).toBe(0);
  });

  it('releases the concurrency slot when the inner pipeline throws', async () => {
    const c = makeCase();
    c.inner.failWith = new Error('provider exploded');

    await expect(c.useCase.execute(command())).rejects.toThrow('provider exploded');

    // A still-held slot would refuse this with `guard.concurrent_request`
    // forever — the bot would be dead in that chat until a restart.
    c.inner.failWith = null;
    c.clock.advance({ minutes: 5 });
    const outcome = await c.useCase.execute(command());
    expect(outcome).toEqual({ kind: 'refused', code: 'corpus.empty' });
    expect(c.inner.calls).toBe(2);
  });

  it('does not cache a refusal: the next identical request really does retry', async () => {
    const c = makeCase();

    await c.useCase.execute(command());
    c.clock.advance({ minutes: 2 });
    await c.useCase.execute(command());

    expect(c.inner.calls).toBe(2);
  });
});
