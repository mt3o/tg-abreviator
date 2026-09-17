/**
 * The composition root's other half: the driving ports the answer pipeline
 * does not touch.
 *
 * `e2e-forum-topic.test.ts` proves `/tldr <range> <question>` works end to
 * end. This one proves the rest of DESIGN §2's command table is actually
 * plugged in — `/forgetme`, `/forget`, `/tldr tz`, `/tldr model`, `/tldr dm`,
 * `/tldr stats`, `/privacy` — because a command wired to nothing fails at
 * runtime, in front of a user, and typechecks perfectly.
 */
import { describe, expect, it } from 'vitest';
import type { Message as TelegramMessage, Update } from 'grammy/types';

import type { GetUpdatesParams, TelegramUpdatesSource } from '../../src/adapters/inbound/telegram/poller.js';
import { buildApplication } from '../../src/bootstrap/container.js';
import type { Application } from '../../src/bootstrap/container.js';
import { asChatId, asUserId } from '../../src/domain/model/ids.js';
import type { ChatId } from '../../src/domain/model/ids.js';
import { Temporal } from '../../src/domain/time/temporal.js';
import { createFakeEnvironment } from '../fakes/create-fake-stores.js';
import type { FakeEnvironment } from '../fakes/create-fake-stores.js';
import { FakeClock } from '../fakes/fake-clock.js';
import { FakeConfig, TEST_ENV_LAYER } from '../fakes/fake-config.js';
import { makeMessage, makeUsageEvent } from '../conformance/support.js';

const CHAT: ChatId = asChatId(-1009000001);
const MEMBER = 11;
const ADMIN = 22;
const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');

class NoUpdates implements TelegramUpdatesSource {
  async getUpdates(_params: GetUpdatesParams): Promise<readonly Update[]> {
    return await Promise.resolve([]);
  }
}

interface Harness {
  readonly env: FakeEnvironment;
  readonly app: Application;
}

function makeHarness(): Harness {
  const clock = new FakeClock(NOW);
  const config = new FakeConfig({
    file: {
      telegram: { allowlist: [CHAT] },
      bot: { operatorContact: '@operator', commandName: 'tldr', language: 'pl' },
    },
    env: TEST_ENV_LAYER,
  });
  const env = createFakeEnvironment({ clock, config });
  env.gateway.setMemberStatus(CHAT, asUserId(ADMIN), 'administrator');

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
    gateway: env.gateway,
    llm: env.llm,
    clock,
    ids: env.ids,
    reporter: env.reporter,
    updatesSource: new NoUpdates(),
  });
  return { env, app };
}

let nextId = 700;

function command(text: string, userId: number): Update {
  nextId += 1;
  const token = text.split(' ')[0] ?? text;
  const message: TelegramMessage = {
    message_id: nextId,
    date: Math.floor(NOW.epochMilliseconds / 1000),
    chat: { id: CHAT, type: 'supergroup', title: 'Zespół' },
    from: { id: userId, is_bot: false, first_name: userId === ADMIN ? 'Ola' : 'Ala' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: token.length }],
  };
  return { update_id: nextId, message } as Update;
}

function lastReply(harness: Harness): string {
  return harness.env.gateway.sent.at(-1)?.params.text ?? '';
}

describe('the composition root wires every command', () => {
  it('/forgetme runs the real erasure cascade', async () => {
    const h = makeHarness();
    await h.env.messages.upsertMany(CHAT, [
      makeMessage({ chatId: CHAT, messageId: 1, userId: asUserId(MEMBER), text: 'moje' }),
      makeMessage({ chatId: CHAT, messageId: 2, userId: asUserId(ADMIN), text: 'cudze' }),
    ]);

    const outcome = await h.app.dispatcher.dispatch(command('/forgetme', MEMBER));

    expect(outcome.kind).toBe('handled');
    expect(h.env.messages.dump(CHAT).map((row) => row.userId)).toEqual([asUserId(ADMIN)]);
    expect(await h.env.optOuts.isOptedOut(CHAT, asUserId(MEMBER))).toBe(true);
    expect(lastReply(h)).toContain('Usunięto 1');
  });

  it('/forget wipes the chat for an admin and is denied to a member', async () => {
    const h = makeHarness();
    await h.env.messages.upsert(CHAT, makeMessage({ chatId: CHAT, messageId: 1 }));

    const denied = await h.app.dispatcher.dispatch(command('/forget', MEMBER));
    expect(denied.kind).toBe('denied');
    expect(h.env.messages.dump(CHAT)).toHaveLength(1);

    const allowed = await h.app.dispatcher.dispatch(command('/forget', ADMIN));
    expect(allowed.kind).toBe('handled');
    expect(h.env.messages.dump(CHAT)).toHaveLength(0);
  });

  it('/tldr tz and /tldr model write the chat settings layer', async () => {
    const h = makeHarness();

    await h.app.dispatcher.dispatch(command('/tldr tz Europe/Warsaw', ADMIN));
    await h.app.dispatcher.dispatch(command('/tldr model haiku', ADMIN));

    const settings = await h.env.settings.getChatSettings(CHAT);
    expect(settings?.tz).toBe('Europe/Warsaw');
    expect(settings?.modelAlias).toBe('haiku');
  });

  it('/tldr model rejects an alias that is not in the registry', async () => {
    const h = makeHarness();

    await h.app.dispatcher.dispatch(command('/tldr model gpt-9', ADMIN));

    expect(await h.env.settings.getChatSettings(CHAT)).toBeNull();
    expect(lastReply(h)).toContain('Nieznany model');
  });

  it('/tldr dm on records a per-user delivery preference', async () => {
    const h = makeHarness();

    await h.app.dispatcher.dispatch(command('/tldr dm on', MEMBER));

    expect((await h.env.settings.getUserPrefs(CHAT, asUserId(MEMBER)))?.dmDelivery).toBe(true);
  });

  it('/tldr stats reads real usage rows', async () => {
    const h = makeHarness();
    await h.env.usage.record(CHAT, makeUsageEvent({ chatId: CHAT, costMicros: 12_345 }));

    const outcome = await h.app.dispatcher.dispatch(command('/tldr stats', ADMIN));

    expect(outcome.kind).toBe('handled');
    expect(lastReply(h)).toContain('claude-sonnet-5');
  });

  it('/privacy answers without touching any store', async () => {
    const h = makeHarness();

    const outcome = await h.app.dispatcher.dispatch(command('/privacy', MEMBER));

    expect(outcome.kind).toBe('handled');
    expect(lastReply(h)).toContain('@operator');
    expect(h.env.reporter.events).toHaveLength(0);
  });
});
