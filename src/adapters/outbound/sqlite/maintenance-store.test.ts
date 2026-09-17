/**
 * `MaintenanceStore` is not part of the shared port-conformance suite
 * (`test/conformance/all-stores.ts` only bundles the six chat-scoped
 * stores), so it gets its own direct test here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asChatId, asMessageId, asUserId } from '../../../domain/model/ids.js';
import type { ChatId } from '../../../domain/model/ids.js';
import { Temporal } from '../../../domain/time/temporal.js';
import { closeDatabase, openDatabase } from './database.js';
import { createSqliteStores } from './stores.js';
import type { SqliteStores } from './stores.js';

class FixedClock {
  now(): Temporal.Instant {
    return T0;
  }
  nowIn(timeZone: string): Temporal.ZonedDateTime {
    return T0.toZonedDateTimeISO(timeZone);
  }
  async sleep(): Promise<void> {
    await Promise.resolve();
  }
}

class ZeroIdGenerator {
  uuid(): string {
    return 'uuid';
  }
  token(): string {
    return 'token';
  }
  randomInt(maxExclusive: number): number {
    return maxExclusive > 0 ? 0 : 0;
  }
}

const T0 = Temporal.Instant.from('2026-09-17T09:00:00Z');
const CHAT_WITH_MESSAGES: ChatId = asChatId(-1);
const CHAT_WITH_ONLY_OPT_OUT: ChatId = asChatId(-2);
const CHAT_WITH_ONLY_SETTINGS: ChatId = asChatId(-3);
const CHAT_NEVER_SEEN: ChatId = asChatId(-4);

describe('SqliteMaintenanceStore', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let stores: SqliteStores;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-abreviator-maintenance-'));
    db = openDatabase({ path: join(dir, 'test.db') });
    stores = createSqliteStores(db, { clock: new FixedClock(), ids: new ZeroIdGenerator() });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every chat with data in any store, and nothing else', async () => {
    await stores.messages.upsert(CHAT_WITH_MESSAGES, {
      chatId: CHAT_WITH_MESSAGES,
      messageId: asMessageId(1),
      threadId: null,
      userId: asUserId(1),
      displayName: 'Ala',
      ts: T0,
      replyToMessageId: null,
      kind: 'text',
      text: 'hi',
    });
    await stores.optOuts.optOut(CHAT_WITH_ONLY_OPT_OUT, asUserId(2));
    await stores.settings.putChatSettings(
      CHAT_WITH_ONLY_SETTINGS,
      { tz: 'Europe/Warsaw' },
      asUserId(3),
      T0,
    );

    const chatIds = await stores.maintenance.listChatIds();

    expect([...chatIds].sort((a, b) => a - b)).toEqual(
      [CHAT_WITH_MESSAGES, CHAT_WITH_ONLY_OPT_OUT, CHAT_WITH_ONLY_SETTINGS].sort((a, b) => a - b),
    );
    expect(chatIds).not.toContain(CHAT_NEVER_SEEN);
  });

  it('returns an empty list on a fresh database', async () => {
    expect(await stores.maintenance.listChatIds()).toEqual([]);
  });
});
