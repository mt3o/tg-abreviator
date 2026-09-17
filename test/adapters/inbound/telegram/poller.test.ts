/**
 * Table-driven fixture tests for the poller pipeline (DESIGN §1, §3, §4, §5).
 *
 * Every case here is a recorded `Update` JSON fixture (see `fixtures/`) run
 * through `processUpdate` / `processBotJoin` / `TelegramPoller.pollOnce()`,
 * entirely against Phase 0's fakes — no network, no grammY runtime beyond its
 * plain `Update` type.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';

import {
  GapMarkerTracker,
  TelegramPoller,
  processBotJoin,
  processUpdate,
} from '../../../../src/adapters/inbound/telegram/poller.js';
import type { TelegramUpdatesSource } from '../../../../src/adapters/inbound/telegram/poller.js';
import { IngestMessageUseCase } from '../../../../src/application/usecases/ingest-message.js';
import { Temporal } from '../../../../src/domain/time/temporal.js';
import { asChatId, asUserId } from '../../../../src/domain/model/ids.js';
import { FakeChatGateway } from '../../../fakes/fake-chat-gateway.js';
import { FakeClock } from '../../../fakes/fake-clock.js';
import { FakeConfig, TEST_ENV_LAYER } from '../../../fakes/fake-config.js';
import { FakeErrorReporter } from '../../../fakes/fake-error-reporter.js';
import { FakeMessageStore } from '../../../fakes/fake-message-store.js';
import { FakeOptOutStore } from '../../../fakes/fake-opt-out-store.js';
import { FakePollStateStore } from '../../../fakes/fake-poll-state-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

function fixture(name: string): Update {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as Update;
}

const HOME_CHAT = asChatId(-1009000001);
const OUTSIDE_CHAT = asChatId(-1009999999);
const BOT_USER_ID = asUserId(999000001);

function makeEnvironment() {
  const messages = new FakeMessageStore();
  const optOuts = new FakeOptOutStore();
  const gateway = new FakeChatGateway({ identity: { userId: BOT_USER_ID, username: 'tg_abreviator_test_bot' } });
  const config = new FakeConfig({
    file: {
      telegram: { allowlist: [HOME_CHAT] },
      bot: { operatorContact: '@operator', announceOnJoin: true },
      retention: { gapThresholdMinutes: 15 },
    },
    env: TEST_ENV_LAYER,
  });
  const ingest = new IngestMessageUseCase({ messages, optOuts, config, gateway });
  return { messages, optOuts, gateway, config, ingest };
}

/** Never triggers: used by tests that are not exercising gap detection. */
function noGap(): GapMarkerTracker {
  return new GapMarkerTracker(null, Temporal.Instant.from('2026-09-17T12:00:00Z'), 15);
}

describe('processUpdate — table-driven fixtures', () => {
  let env: ReturnType<typeof makeEnvironment>;

  beforeEach(() => {
    env = makeEnvironment();
  });

  it('stores a plain non-forum message', async () => {
    const outcome = await processUpdate(fixture('message-non-forum.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'stored' });
    const rows = env.messages.dump(HOME_CHAT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBeNull();
    expect(rows[0]?.text).toContain('build');
  });

  it('scopes a forum message to its topic thread', async () => {
    const outcome = await processUpdate(fixture('message-forum-topic.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'stored' });
    const rows = env.messages.dump(HOME_CHAT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe(7);
  });

  it('updates an edited message in place rather than adding a row', async () => {
    await processUpdate(fixture('message-non-forum.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    const outcome = await processUpdate(fixture('edited-message.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'updated' });
    const rows = env.messages.dump(HOME_CHAT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain('już wiem');
  });

  it('is idempotent under a replayed update (same message twice)', async () => {
    const ctx = {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    };
    const first = await processUpdate(fixture('message-non-forum.json'), ctx);
    const replay = await processUpdate(fixture('message-non-forum.json'), ctx);
    expect(first).toEqual({ kind: 'stored' });
    expect(replay).toEqual({ kind: 'stored' });
    expect(env.messages.dump(HOME_CHAT)).toHaveLength(1);
  });

  it('leaves no trace for an opted-out user', async () => {
    const senderId = asUserId(33);
    await env.optOuts.optOut(HOME_CHAT, senderId);
    const outcome = await processUpdate(fixture('message-opted-out-user.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'opted_out' });
    expect(env.messages.dump(HOME_CHAT)).toHaveLength(0);
  });

  it('skips a message from a different bot', async () => {
    const raw = fixture('message-other-bot.json');
    const ctx = { ingest: env.ingest, botUserId: BOT_USER_ID, gapTracker: noGap(), messages: env.messages, config: env.config };
    const outcome = await processUpdate(raw, ctx);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'other_bot' });
    expect(env.messages.dump(HOME_CHAT)).toHaveLength(0);
  });

  it("skips this bot's own messages", async () => {
    const outcome = await processUpdate(fixture('message-own-bot.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'own_message' });
    expect(env.messages.dump(HOME_CHAT)).toHaveLength(0);
  });

  it('replies "not authorised", leaves the chat, and stores nothing for an off-allowlist chat', async () => {
    const outcome = await processUpdate(fixture('message-unauthorised-chat.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'left_chat' });
    expect(env.gateway.leftChats).toContain(OUTSIDE_CHAT);
    expect(env.messages.dump(OUTSIDE_CHAT)).toHaveLength(0);
  });

  it('treats message_id 0 (Telegram\'s "not usable yet" marker) as no_content, without crashing', async () => {
    const outcome = await processUpdate(fixture('message-ephemeral-unusable.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_content' });
  });

  it('stores a media message as its caption plus a kind placeholder', async () => {
    const outcome = await processUpdate(fixture('message-photo-caption.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'stored' });
    const rows = env.messages.dump(HOME_CHAT);
    expect(rows[0]?.kind).toBe('photo');
    expect(rows[0]?.text).toBe('zrzut ekranu z buildem');
  });

  it('stores a service message with a null-text row', async () => {
    const outcome = await processUpdate(fixture('message-service-pinned.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'stored' });
    expect(env.messages.dump(HOME_CHAT)[0]?.kind).toBe('service');
  });

  it('redacts a secret before it is ever written to the store', async () => {
    await processUpdate(fixture('message-with-secret.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    const row = env.messages.dump(HOME_CHAT)[0];
    expect(row?.text).not.toContain('sk-ant-api03');
    expect(row?.text).toContain('[redacted]');
  });

  it('ignores update kinds this workstream does not own (e.g. callback_query)', async () => {
    const outcome = await processUpdate(fixture('callback-query.json'), {
      ingest: env.ingest,
      botUserId: BOT_USER_ID,
      gapTracker: noGap(),
      messages: env.messages,
      config: env.config,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not_a_message' });
  });
});

describe('startup gap detection', () => {
  let env: ReturnType<typeof makeEnvironment>;

  beforeEach(() => {
    env = makeEnvironment();
  });

  it('inserts exactly one gap_marker row when the downtime exceeds the threshold', async () => {
    const lastSeenAt = Temporal.Instant.from('2026-09-17T09:00:00Z');
    const startedAt = Temporal.Instant.from('2026-09-17T12:00:00Z'); // 3h gap, threshold 15m
    const gapTracker = new GapMarkerTracker(lastSeenAt, startedAt, 15);

    const ctx = { ingest: env.ingest, botUserId: BOT_USER_ID, gapTracker, messages: env.messages, config: env.config };
    await processUpdate(fixture('message-non-forum.json'), ctx);
    // A second update in the same (chat, thread) must not add a second marker.
    await processUpdate(fixture('message-with-secret.json'), ctx);

    const rows = env.messages.dump(HOME_CHAT);
    const markers = rows.filter((row) => row.kind === 'gap_marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.ts.epochMilliseconds).toBe(startedAt.epochMilliseconds);
  });

  it('inserts a marker per distinct thread', async () => {
    const lastSeenAt = Temporal.Instant.from('2026-09-17T09:00:00Z');
    const startedAt = Temporal.Instant.from('2026-09-17T12:00:00Z');
    const gapTracker = new GapMarkerTracker(lastSeenAt, startedAt, 15);
    const ctx = { ingest: env.ingest, botUserId: BOT_USER_ID, gapTracker, messages: env.messages, config: env.config };

    await processUpdate(fixture('message-non-forum.json'), ctx); // General
    await processUpdate(fixture('message-forum-topic.json'), ctx); // topic 7

    const markers = env.messages.dump(HOME_CHAT).filter((row) => row.kind === 'gap_marker');
    expect(markers).toHaveLength(2);
  });

  it('does not fire when the gap is under the threshold', async () => {
    const lastSeenAt = Temporal.Instant.from('2026-09-17T11:50:00Z');
    const startedAt = Temporal.Instant.from('2026-09-17T12:00:00Z'); // 10 minutes, threshold 15
    const gapTracker = new GapMarkerTracker(lastSeenAt, startedAt, 15);
    const ctx = { ingest: env.ingest, botUserId: BOT_USER_ID, gapTracker, messages: env.messages, config: env.config };

    await processUpdate(fixture('message-non-forum.json'), ctx);
    expect(env.messages.dump(HOME_CHAT).some((row) => row.kind === 'gap_marker')).toBe(false);
  });

  it('does not fire on a fresh database (no prior lastSeenAt)', async () => {
    const startedAt = Temporal.Instant.from('2026-09-17T12:00:00Z');
    const gapTracker = new GapMarkerTracker(null, startedAt, 15);
    const ctx = { ingest: env.ingest, botUserId: BOT_USER_ID, gapTracker, messages: env.messages, config: env.config };

    await processUpdate(fixture('message-non-forum.json'), ctx);
    expect(env.messages.dump(HOME_CHAT).some((row) => row.kind === 'gap_marker')).toBe(false);
  });

  it('never writes a gap marker into a chat off the allowlist — "store nothing" means nothing', async () => {
    const lastSeenAt = Temporal.Instant.from('2026-09-17T09:00:00Z');
    const startedAt = Temporal.Instant.from('2026-09-17T12:00:00Z');
    const gapTracker = new GapMarkerTracker(lastSeenAt, startedAt, 15);
    const ctx = { ingest: env.ingest, botUserId: BOT_USER_ID, gapTracker, messages: env.messages, config: env.config };

    const outcome = await processUpdate(fixture('message-unauthorised-chat.json'), ctx);
    expect(outcome).toEqual({ kind: 'left_chat' });
    expect(env.messages.dump(OUTSIDE_CHAT)).toHaveLength(0);
  });
});

describe('processBotJoin — join announcement (DESIGN §5)', () => {
  let env: ReturnType<typeof makeEnvironment>;

  beforeEach(() => {
    env = makeEnvironment();
  });

  it('announces on join to an allowlisted chat, carrying the operator contact', async () => {
    const outcome = await processBotJoin(fixture('bot-joined-chat.json'), {
      botUserId: BOT_USER_ID,
      config: env.config,
      gateway: env.gateway,
    });
    expect(outcome).toEqual({ kind: 'joined', chatId: HOME_CHAT });
    const texts = env.gateway.textsFor(HOME_CHAT);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('@operator');
  });

  it('refuses and leaves a chat off the allowlist on join, storing nothing', async () => {
    const outcome = await processBotJoin(fixture('bot-joined-unauthorised-chat.json'), {
      botUserId: BOT_USER_ID,
      config: env.config,
      gateway: env.gateway,
    });
    expect(outcome).toEqual({ kind: 'join_not_authorised', chatId: OUTSIDE_CHAT });
    expect(env.gateway.leftChats).toContain(OUTSIDE_CHAT);
  });

  it('is a no-op for updates that are not a join transition', async () => {
    const outcome = await processBotJoin(fixture('message-non-forum.json'), {
      botUserId: BOT_USER_ID,
      config: env.config,
      gateway: env.gateway,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not_a_message' });
  });
});

describe('TelegramPoller', () => {
  let env: ReturnType<typeof makeEnvironment>;
  let pollState: FakePollStateStore;
  let clock: FakeClock;
  let reporter: FakeErrorReporter;

  beforeEach(() => {
    env = makeEnvironment();
    pollState = new FakePollStateStore();
    clock = new FakeClock(Temporal.Instant.from('2026-09-17T12:00:00Z'));
    reporter = new FakeErrorReporter();
  });

  function makePoller(source: TelegramUpdatesSource): TelegramPoller {
    return new TelegramPoller({
      updatesSource: source,
      ingest: env.ingest,
      messages: env.messages,
      pollState,
      config: env.config,
      gateway: env.gateway,
      clock,
      reporter,
    });
  }

  function fixedSource(batches: readonly (readonly Update[])[]): TelegramUpdatesSource {
    let call = 0;
    return {
      async getUpdates() {
        const batch = batches[call] ?? [];
        call += 1;
        return await Promise.resolve(batch);
      },
    };
  }

  it('processes a batch and persists the offset past every update', async () => {
    const poller = makePoller(fixedSource([[fixture('message-non-forum.json'), fixture('message-forum-topic.json')]]));
    const outcomes = await poller.pollOnce();
    expect(outcomes).toEqual([{ kind: 'stored' }, { kind: 'stored' }]);
    expect(pollState.writes.at(-1)?.lastUpdateId).toBe(100002);
    expect(env.messages.dump(HOME_CHAT)).toHaveLength(2);
  });

  it('resumes from the persisted offset across restarts (crash recovery)', async () => {
    await pollState.save({ lastUpdateId: 100001, lastSeenAt: Temporal.Instant.from('2026-09-17T11:59:00Z') });
    let requestedOffset: number | undefined;
    const source: TelegramUpdatesSource = {
      async getUpdates(params) {
        requestedOffset = params.offset;
        return await Promise.resolve([]);
      },
    };
    const poller = makePoller(source);
    await poller.pollOnce();
    expect(requestedOffset).toBe(100002);
  });

  it('persists lastSeenAt even on an empty batch, so idle time is never mistaken for downtime', async () => {
    const poller = makePoller(fixedSource([[]]));
    await poller.pollOnce();
    expect(pollState.writes).toHaveLength(1);
    expect(pollState.writes[0]?.lastSeenAt.epochMilliseconds).toBe(clock.now().epochMilliseconds);
  });

  it('advances past an update whose processing throws, and reports it, rather than wedging forever', async () => {
    const poisoned: Update = {
      update_id: 999999,
      message: {
        message_id: 1,
        date: 1758100000,
        // No `chat` field at all: this cannot be mapped and must throw inside
        // processUpdate rather than silently doing nothing.
      } as never,
    };
    const poller = makePoller(fixedSource([[poisoned, fixture('message-non-forum.json')]]));
    const outcomes = await poller.pollOnce();
    // The second, valid update in the same batch still gets processed.
    expect(outcomes).toEqual([{ kind: 'stored' }]);
    expect(pollState.writes.at(-1)?.lastUpdateId).toBe(100001);
    expect(reporter.events.length).toBeGreaterThan(0);
  });

  it('routes a join update through the announcement path, not the ingest path', async () => {
    const poller = makePoller(fixedSource([[fixture('bot-joined-chat.json')]]));
    const outcomes = await poller.pollOnce();
    expect(outcomes).toEqual([{ kind: 'joined', chatId: HOME_CHAT }]);
  });
});
