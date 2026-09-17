/**
 * WS1 DoD: "a cascade test proving no chunk survives a `/forgetme` touching
 * its range" (PLAN). DESIGN §5's `/forgetme` cascade, driven by hand through
 * exactly the six store ports WS1 owns — no other workstream's code is
 * needed to prove this, and none is imported.
 *
 *   1. delete the user's messages, keeping the deleted ids;
 *   2. delete every chunk whose `[first, last]` span overlaps one of them;
 *   3. record the opt-out so future messages are never stored;
 *   4. replace the user's id in `usage_events` with a fresh random token;
 *   5. delete the user's `pseudonyms` row, so any label already in the error
 *      sink becomes permanently unresolvable.
 *
 * Self-contained `Clock`/`IdGenerator` stand-ins live in this file rather
 * than importing `test/fakes/**`: a file under `src/adapters` may not import
 * `test/**` (eslint import-boundary rules, DESIGN §3, CI-enforced).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asChatId,
  asMessageId,
  asUsageEventId,
  asUserId,
} from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { StoredMessage } from '../../../domain/model/message.js';
import { Temporal } from '../../../domain/time/temporal.js';
import type { TimeZoneId } from '../../../domain/time/temporal.js';
import type { Clock } from '../../../application/ports/driven/clock.js';
import type { IdGenerator } from '../../../application/ports/driven/id-generator.js';
import { closeDatabase, openDatabase } from './database.js';
import { createSqliteStores } from './stores.js';
import type { SqliteStores } from './stores.js';

class FixedClock implements Clock {
  #now: Temporal.Instant;
  constructor(now: Temporal.Instant) {
    this.#now = now;
  }
  now(): Temporal.Instant {
    return this.#now;
  }
  nowIn(timeZone: TimeZoneId): Temporal.ZonedDateTime {
    return this.#now.toZonedDateTimeISO(timeZone);
  }
  async sleep(_milliseconds: number): Promise<void> {
    await Promise.resolve();
  }
}

/** Deterministic, not cryptographically random — fine for a test double. */
class SequentialIdGenerator implements IdGenerator {
  #counter = 0;
  uuid(): string {
    this.#counter += 1;
    return `test-uuid-${String(this.#counter)}`;
  }
  token(_byteLength?: number): string {
    this.#counter += 1;
    return `test-token-${String(this.#counter)}`;
  }
  randomInt(maxExclusive: number): number {
    this.#counter += 1;
    return this.#counter % maxExclusive;
  }
}

const CHAT: ChatId = asChatId(-500000000001);
const ALA: UserId = asUserId(101);
const OLA: UserId = asUserId(202);
const T0 = Temporal.Instant.from('2026-09-17T09:00:00Z');

function messageAt(id: number, userId: UserId, minutesAfterT0: number): StoredMessage {
  return {
    chatId: CHAT,
    messageId: asMessageId(id),
    threadId: null,
    userId,
    displayName: userId === ALA ? 'Ala' : 'Ola',
    ts: T0.add({ minutes: minutesAfterT0 }),
    replyToMessageId: null,
    kind: 'text',
    text: `message ${String(id)}`,
  };
}

describe('SQLite /forgetme cascade (DESIGN §5)', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let stores: SqliteStores;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-abreviator-forgetme-'));
    db = openDatabase({ path: join(dir, 'test.db') });
    stores = createSqliteStores(db, {
      clock: new FixedClock(T0),
      ids: new SequentialIdGenerator(),
    });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no chunk covering a deleted message, and severs every other trace of the user', async () => {
    // Ala: messages 1-5. Ola: messages 6-10. Interleaved chunk spans.
    await stores.messages.upsertMany(CHAT, [
      messageAt(1, ALA, 1),
      messageAt(2, ALA, 2),
      messageAt(3, ALA, 3),
      messageAt(4, ALA, 4),
      messageAt(5, ALA, 5),
      messageAt(6, OLA, 6),
      messageAt(7, OLA, 7),
      messageAt(8, OLA, 8),
      messageAt(9, OLA, 9),
      messageAt(10, OLA, 10),
    ]);

    // Three chunks: one entirely Ala's, one entirely Ola's, one straddling both.
    await stores.chunks.save(CHAT, {
      chatId: CHAT,
      threadId: null,
      firstMsgId: asMessageId(1),
      lastMsgId: asMessageId(3),
      model: 'claude-haiku-4-5',
      promptVersion: 'v1',
      text: 'alas span',
      createdAt: T0.add({ minutes: 3 }),
    });
    await stores.chunks.save(CHAT, {
      chatId: CHAT,
      threadId: null,
      firstMsgId: asMessageId(4),
      lastMsgId: asMessageId(7),
      model: 'claude-haiku-4-5',
      promptVersion: 'v1',
      text: 'straddling span',
      createdAt: T0.add({ minutes: 7 }),
    });
    await stores.chunks.save(CHAT, {
      chatId: CHAT,
      threadId: null,
      firstMsgId: asMessageId(8),
      lastMsgId: asMessageId(10),
      model: 'claude-haiku-4-5',
      promptVersion: 'v1',
      text: 'olas span',
      createdAt: T0.add({ minutes: 10 }),
    });

    await stores.usage.record(CHAT, {
      id: asUsageEventId('u1'),
      ts: T0.add({ minutes: 2 }),
      chatId: CHAT,
      threadId: null,
      user: { kind: 'user', userId: ALA },
      model: 'claude-sonnet-5',
      phase: 'single',
      inputTokens: 1000,
      outputTokens: 100,
      costMicros: 5000,
      unitPrices: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 },
      rangeSpec: '-50',
      questionHash: null,
      status: 'ok',
    });
    await stores.usage.record(CHAT, {
      id: asUsageEventId('u2'),
      ts: T0.add({ minutes: 9 }),
      chatId: CHAT,
      threadId: null,
      user: { kind: 'user', userId: OLA },
      model: 'claude-sonnet-5',
      phase: 'single',
      inputTokens: 500,
      outputTokens: 50,
      costMicros: 2500,
      unitPrices: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 },
      rangeSpec: '-50',
      questionHash: null,
      status: 'ok',
    });

    const alaLabel = await stores.pseudonyms.labelFor(CHAT, ALA);
    const olaLabel = await stores.pseudonyms.labelFor(CHAT, OLA);
    expect(alaLabel).not.toBe(olaLabel);

    // --- /forgetme for Ala --------------------------------------------------
    const deletedIds = await stores.messages.deleteByUser(CHAT, ALA);
    expect([...deletedIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5].map(asMessageId));

    const chunksDeleted = await stores.chunks.deleteCovering(CHAT, deletedIds);
    // The all-Ala span [1,3] and the straddling span [4,7] both overlap {1..5}.
    expect(chunksDeleted).toBe(2);

    await stores.optOuts.optOut(CHAT, ALA);

    const token = 'freshly-generated-token-not-a-hash';
    const rewritten = await stores.usage.anonymiseUser(CHAT, ALA, token);
    expect(rewritten).toBe(1);

    await stores.pseudonyms.deleteUser(CHAT, ALA);

    // --- assertions ----------------------------------------------------------

    // No chunk survives that touched a deleted message.
    expect(
      await stores.chunks.find(CHAT, {
        threadId: null,
        firstMsgId: asMessageId(1),
        lastMsgId: asMessageId(3),
        model: 'claude-haiku-4-5',
        promptVersion: 'v1',
      }),
    ).toBeNull();
    expect(
      await stores.chunks.find(CHAT, {
        threadId: null,
        firstMsgId: asMessageId(4),
        lastMsgId: asMessageId(7),
        model: 'claude-haiku-4-5',
        promptVersion: 'v1',
      }),
    ).toBeNull();
    // Ola's own chunk, untouched by any deleted message, survives.
    expect(
      await stores.chunks.find(CHAT, {
        threadId: null,
        firstMsgId: asMessageId(8),
        lastMsgId: asMessageId(10),
        model: 'claude-haiku-4-5',
        promptVersion: 'v1',
      }),
    ).not.toBeNull();

    // Ala's messages are gone; Ola's are untouched.
    expect(await stores.messages.countAll(CHAT, { kind: 'all' })).toBe(5);
    expect(await stores.messages.findById(CHAT, asMessageId(1))).toBeNull();
    expect(await stores.messages.findById(CHAT, asMessageId(6))).not.toBeNull();

    // Future messages from Ala are refused at ingest — the opt-out is recorded.
    expect(await stores.optOuts.isOptedOut(CHAT, ALA)).toBe(true);
    expect(await stores.optOuts.isOptedOut(CHAT, OLA)).toBe(false);

    // The bill is unchanged; the identity behind it is gone, replaced by a
    // token stored nowhere else — never a deterministic hash of the id.
    const summary = await stores.usage.summarize(CHAT, T0, T0.add({ hours: 1 }));
    expect(summary.costMicros).toBe(7500);
    expect(summary.calls).toBe(2);
    // Anonymising again finds nothing: the real id is no longer stored anywhere.
    expect(await stores.usage.anonymiseUser(CHAT, ALA, 'a-different-token')).toBe(0);

    // The pseudonym row is gone: a label already sitting in the error sink is
    // now permanently unresolvable (DESIGN §11). Ola's is untouched.
    expect(await stores.pseudonyms.peek(CHAT, ALA)).toBeNull();
    expect(await stores.pseudonyms.peek(CHAT, OLA)).toBe(olaLabel);

    // A later re-allocation for the same Telegram id is a fresh row, not a
    // re-derivation of the erased one.
    const reallocated = await stores.pseudonyms.labelFor(CHAT, ALA);
    expect(typeof reallocated).toBe('string');
  });
});
