/**
 * Wave 3's definition of done (`docs/PLAN.md`):
 *
 * > end-to-end test against the fake Telegram API and fake provider —
 * > `/tldr -50 co ustalili?` in a forum topic produces a correctly scoped,
 * > correctly rendered, correctly billed answer.
 *
 * Everything below `buildApplication` is the real thing: WS2's poller and
 * mapping, WS6's dispatcher and command routing, WS3's range grammar, WS10's
 * corpus assembly and single-shot pipeline, WS12's guards and usage writer,
 * WS5's renderer. Only the two edges the process cannot own in a test are
 * faked — Telegram (the updates source and `ChatGateway`) and the provider
 * (`Llm`) — which is exactly the pair Phase 0 shipped fakes for.
 *
 * The updates arrive as one `getUpdates` batch, the way they would in
 * production: sixty messages in the `Deploys` topic, five in another topic,
 * and the invocation last. Nothing is hand-fed to a use case.
 */
import { describe, expect, it } from 'vitest';
import type { Message as TelegramMessage, Update } from 'grammy/types';

import type { GetUpdatesParams, TelegramUpdatesSource } from '../../src/adapters/inbound/telegram/poller.js';
import { buildApplication } from '../../src/bootstrap/container.js';
import type { Application } from '../../src/bootstrap/container.js';
import { computeCostMicros } from '../../src/domain/cost.js';
import { asChatId, asUserId } from '../../src/domain/model/ids.js';
import type { ChatId } from '../../src/domain/model/ids.js';
import type { UsageEvent } from '../../src/domain/model/usage.js';
import { Temporal } from '../../src/domain/time/temporal.js';
import { createFakeEnvironment } from '../fakes/create-fake-stores.js';
import type { FakeEnvironment } from '../fakes/create-fake-stores.js';
import { FakeClock } from '../fakes/fake-clock.js';
import { FakeConfig, TEST_ENV_LAYER } from '../fakes/fake-config.js';

/* -------------------------------------------------------------------------- */
/* The chat                                                                   */
/* -------------------------------------------------------------------------- */

const CHAT: ChatId = asChatId(-1009000001);
const TOPIC_DEPLOYS = 7;
const TOPIC_RANDOM = 9;
const ALA = 11;
const OLA = 22;

const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const FIRST_MESSAGE_AT = Temporal.Instant.from('2026-09-17T10:00:00Z');

/** Telegram `date` is epoch **seconds**. */
function epochSeconds(instant: Temporal.Instant): number {
  return Math.floor(instant.epochMilliseconds / 1000);
}

interface MessageOptions {
  readonly threadId?: number;
  readonly entities?: TelegramMessage['entities'];
}

let nextUpdateId = 5000;
let nextMessageId = 500;

function messageUpdate(text: string, userId: number, secondsIn: number, options: MessageOptions = {}): Update {
  nextUpdateId += 1;
  nextMessageId += 1;
  const threadId = options.threadId;
  const message: TelegramMessage = {
    message_id: nextMessageId,
    date: epochSeconds(FIRST_MESSAGE_AT.add({ seconds: secondsIn })),
    chat: { id: CHAT, type: 'supergroup', title: 'Zespół', is_forum: true },
    from: { id: userId, is_bot: false, first_name: userId === ALA ? 'Ala' : 'Ola' },
    text,
    ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
    ...(options.entities === undefined ? {} : { entities: options.entities }),
  };
  return { update_id: nextUpdateId, message } as Update;
}

const COMMAND_TEXT = '/tldr -50 co ustalili?';

function commandUpdate(): Update {
  return messageUpdate(COMMAND_TEXT, ALA, 2100, {
    threadId: TOPIC_DEPLOYS,
    entities: [{ type: 'bot_command', offset: 0, length: '/tldr'.length }],
  });
}

/**
 * Sixty messages in `Deploys`, five in another topic, then the invocation.
 * The sixty are numbered so the test can name the exact cut: `-50` counts
 * *stored human messages*, and the invocation is one of them.
 */
function conversation(): Update[] {
  const updates: Update[] = [];
  for (let index = 1; index <= 60; index += 1) {
    updates.push(
      messageUpdate(`deploy-${String(index)} ustalenie`, index % 2 === 0 ? OLA : ALA, index * 30, {
        threadId: TOPIC_DEPLOYS,
      }),
    );
  }
  for (let index = 1; index <= 5; index += 1) {
    updates.push(
      messageUpdate(`offtop-${String(index)} kotki`, ALA, 1900 + index, { threadId: TOPIC_RANDOM }),
    );
  }
  return updates;
}

/* -------------------------------------------------------------------------- */
/* The process, assembled exactly as `run()` assembles it                     */
/* -------------------------------------------------------------------------- */

class ScriptedUpdatesSource implements TelegramUpdatesSource {
  readonly calls: GetUpdatesParams[] = [];
  readonly #batches: Update[][];

  constructor(batches: Update[][]) {
    this.#batches = [...batches];
  }

  async getUpdates(params: GetUpdatesParams): Promise<readonly Update[]> {
    this.calls.push(params);
    return await Promise.resolve(this.#batches.shift() ?? []);
  }
}

/** The model's answer, carrying hostile markup so rendering can be asserted. */
const SCRIPTED_ANSWER = {
  summary: 'Ustalili, że <script>alert(1)</script> wdrożenie idzie w piątek & rano.',
  keyPoints: ['Wdrożenie w piątek', 'Ola robi rollback plan'],
  unanswered: ['Nie widzę decyzji o terminie testów w tym zakresie'],
  tone: 'neutral',
};

interface Harness {
  readonly env: FakeEnvironment;
  readonly app: Application;
  readonly updates: ScriptedUpdatesSource;
}

function makeHarness(batches: Update[][]): Harness {
  const clock = new FakeClock(NOW);
  const config = new FakeConfig({
    file: {
      telegram: { allowlist: [CHAT] },
      bot: { operatorContact: '@operator', commandName: 'tldr', language: 'pl' },
    },
    env: TEST_ENV_LAYER,
  });
  const env = createFakeEnvironment({ clock, config });
  const gateway = env.gateway;
  const updates = new ScriptedUpdatesSource(batches);
  env.llm.enqueue({ raw: SCRIPTED_ANSWER });

  const app = buildApplication({
    messages: env.messages,
    chunks: env.chunks,
    settings: env.settings,
    optOuts: env.optOuts,
    usage: env.usage,
    globalUsage: env.globalUsage,
    pollState: env.pollState,
    pseudonyms: env.pseudonyms,
    maintenance: env.maintenance,
    config,
    gateway,
    llm: env.llm,
    clock,
    ids: env.ids,
    reporter: env.reporter,
    updatesSource: updates,
  });
  return { env, app, updates };
}

function transcriptOf(harness: Harness): string {
  const request = harness.env.llm.requests[0];
  return request?.userBlocks.find((block) => block.kind === 'transcript')?.text ?? '';
}

function usageEvents(harness: Harness): readonly UsageEvent[] {
  return harness.env.usage.dump(CHAT);
}

/* -------------------------------------------------------------------------- */

describe('end-to-end: /tldr -50 co ustalili? in a forum topic', () => {
  it('ingests the batch, answers the command, and bills the call', async () => {
    const harness = makeHarness([[...conversation(), commandUpdate()]]);

    const outcomes = await harness.app.poller.pollOnce();

    // 65 conversation messages + the invocation, every one of them stored.
    expect(outcomes.filter((outcome) => outcome.kind === 'stored')).toHaveLength(66);
    expect(harness.env.messages.dump(CHAT)).toHaveLength(66);

    /* --- correctly scoped ------------------------------------------------ */

    const transcript = transcriptOf(harness);
    expect(harness.env.llm.requests).toHaveLength(1);

    // `-50` is a message count over *stored human messages* (DESIGN §2), and
    // the invocation itself is one of them: the window is the 49 newest
    // `Deploys` messages plus the command, so `deploy-11` is the first one
    // outside it.
    expect(transcript).toContain('deploy-60');
    expect(transcript).toContain('deploy-12');
    expect(transcript).not.toContain('deploy-11');
    expect(transcript).not.toContain('deploy-1 ');

    // Thread-scoped: the other topic is not in the corpus, in either direction.
    expect(transcript).not.toContain('offtop');

    // The question travels as its own untrusted block, never in `system`
    // (WS4's hard requirement).
    const question = harness.env.llm.requests[0]?.userBlocks.find((block) => block.kind === 'question');
    expect(question?.text).toBe('co ustalili?');
    expect(harness.env.llm.noSystemPromptContains('co ustalili?')).toBe(true);

    /* --- correctly rendered ---------------------------------------------- */

    // DESIGN §8: placeholder into the invoking topic, then edited with the
    // answer. The answer is what the operator sees, so it is what is asserted.
    const placeholder = harness.env.gateway.sent.at(-1);
    expect(placeholder?.params.threadId).toBe(TOPIC_DEPLOYS);
    expect(placeholder?.params.text).toContain('⏳');

    expect(harness.env.gateway.edits).toHaveLength(1);
    const rendered = harness.env.gateway.edits[0]?.params.text ?? '';

    // DESIGN §2: the header states the resolved scope, so a wrong guess is visible.
    expect(rendered).toContain('<b>Wątek: #7 · ostatnie 50 · 50 wiadomości</b>');
    // DESIGN §6.8: the permanent footer, in the chat's language.
    expect(rendered).toContain('🤖 Podsumowanie AI — może się mylić');
    expect(rendered).toContain('Wdrożenie w piątek');
    expect(rendered).toContain('Nie widzę decyzji');
    // DESIGN §6.5: strict allowlist — the model's markup is escaped, not run.
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).toContain('&amp;');
    expect(rendered.length).toBeLessThanOrEqual(4096);
    // Only the three allowlisted tags survive.
    for (const tag of rendered.match(/<\/?([a-zA-Z]+)[^>]*>/g) ?? []) {
      expect(tag).toMatch(/^<\/?(b|i|code)>$/);
    }

    /* --- correctly billed ------------------------------------------------- */

    const events = usageEvents(harness);
    expect(events.map((event) => event.phase)).toEqual(['count_tokens', 'single']);

    const counted = events[0];
    // DESIGN §7: the ceiling is checked with a real count before the call, and
    // the count itself is recorded for the audit trail at zero cost.
    expect(counted?.costMicros).toBe(0);

    const billed = events[1];
    expect(billed).toBeDefined();
    if (billed === undefined) return;
    expect(billed.chatId).toBe(CHAT);
    expect(billed.threadId).toBe(TOPIC_DEPLOYS);
    expect(billed.user).toEqual({ kind: 'user', userId: asUserId(ALA) });
    expect(billed.model).toBe('claude-sonnet-5');
    expect(billed.status).toBe('ok');
    // DESIGN §9: keyed on the raw range token, never the resolved window.
    expect(billed.rangeSpec).toBe('-50');
    // DESIGN §4: the question hash, never the text.
    expect(billed.questionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(billed)).not.toContain('co ustalili?');

    // DESIGN §4: `unit_prices_json` is stored per row, so editing the price
    // table later cannot rewrite this month's history.
    const prices = harness.env.config.get('models').prices['claude-sonnet-5'];
    expect(billed.unitPrices).toEqual(prices);
    expect(billed.inputTokens).toBeGreaterThan(0);
    expect(billed.outputTokens).toBeGreaterThan(0);
    expect(prices).toBeDefined();
    if (prices === undefined) return;
    expect(billed.costMicros).toBe(
      computeCostMicros(
        {
          inputTokens: billed.inputTokens,
          outputTokens: billed.outputTokens,
          cacheReadTokens: 0,
        },
        prices,
      ),
    );
    expect(billed.costMicros).toBeGreaterThan(0);
  });

  it('serves the identical follow-up from the dedupe cache, labelled, without a second provider call', async () => {
    const harness = makeHarness([[...conversation(), commandUpdate()], [commandUpdate()]]);

    await harness.app.poller.pollOnce();
    // DESIGN §9: the cooldown is per user; the case dedupe exists for is "I
    // don't think it heard me, let me re-send", which is a different user
    // re-asking here only because the cooldown would otherwise fire first.
    harness.env.clock.advance({ minutes: 2 });
    await harness.app.poller.pollOnce();

    // One provider call for two invocations (DESIGN §9: "no provider call, no cost").
    expect(harness.env.llm.requests).toHaveLength(1);
    expect(harness.env.gateway.edits).toHaveLength(2);
    const second = harness.env.gateway.edits[1]?.params.text ?? '';
    expect(second).toContain('↺ odpowiedź sprzed 2 min');
    // Nothing new was billed: the count_tokens row and the one call, no more.
    expect(usageEvents(harness).map((event) => event.phase)).toEqual(['count_tokens', 'single']);
  });

  it('refuses a second invocation inside the per-user cooldown', async () => {
    const harness = makeHarness([[...conversation(), commandUpdate()], [commandUpdate()]]);

    await harness.app.poller.pollOnce();
    harness.env.clock.advance({ seconds: 5 });
    await harness.app.poller.pollOnce();

    expect(harness.env.llm.requests).toHaveLength(1);
    const lastSent = harness.env.gateway.sent.at(-1)?.params.text ?? '';
    expect(lastSent).toContain('Za szybko');
  });

  it('never invokes the model for ordinary conversation', async () => {
    const harness = makeHarness([conversation()]);

    await harness.app.poller.pollOnce();

    expect(harness.env.llm.requests).toHaveLength(0);
    expect(harness.env.gateway.sent).toHaveLength(0);
    expect(usageEvents(harness)).toHaveLength(0);
  });
});
