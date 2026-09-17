/**
 * `better-sqlite3` `UsageStore` / `GlobalUsageStore` — `usage_events`
 * (DESIGN §4, §5, §9).
 *
 * `user_id` is `TEXT` precisely so `/forgetme` can replace it with an opaque
 * token (DESIGN §5): a real Telegram id is written as `u:<id>`, an
 * anonymised row as `a:<token>`. Nothing reads this column back into a
 * `UserRef` — `summarize()` and `summarizeGlobal()` are aggregates that carry
 * no user reference at all — so the prefix exists only to keep
 * `anonymiseUser()`'s `WHERE` clause from ever matching an already-anonymised
 * row, or a real id that happens to look like a token.
 */
import type Database from 'better-sqlite3';

import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type {
  UsageEvent,
  UsageModelSummary,
  UsageSummary,
  UserRef,
} from '../../../domain/model/usage.js';
import type { Temporal } from '../../../domain/time/temporal.js';
import { InvalidValueError } from '../../../domain/errors.js';
import type {
  GlobalUsageStore,
  UsageStore,
} from '../../../application/ports/driven/usage-store.js';
import { toEpochMillis } from './codec.js';

const REAL_USER_PREFIX = 'u:';
const ANONYMISED_PREFIX = 'a:';

function encodeUserRef(ref: UserRef): string {
  return ref.kind === 'user' ? `${REAL_USER_PREFIX}${String(ref.userId)}` : `${ANONYMISED_PREFIX}${ref.token}`;
}

interface UsageEventRow {
  readonly id: string;
  readonly ts: number;
  readonly chat_id: number;
  readonly thread_id: number | null;
  readonly user_id: string | null;
  readonly model: string;
  readonly phase: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_micros: number;
  readonly unit_prices_json: string;
  readonly range_spec: string;
  readonly question_hash: string | null;
  readonly status: string;
}

const EMPTY_MODEL_SUMMARY: UsageModelSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

function summarizeRows(
  rows: readonly UsageEventRow[],
  since: Temporal.Instant,
  until: Temporal.Instant,
): UsageSummary {
  const byModel: Record<string, UsageModelSummary> = {};
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;

  for (const row of rows) {
    calls += 1;
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
    costMicros += row.cost_micros;
    const current = byModel[row.model] ?? EMPTY_MODEL_SUMMARY;
    byModel[row.model] = {
      calls: current.calls + 1,
      inputTokens: current.inputTokens + row.input_tokens,
      outputTokens: current.outputTokens + row.output_tokens,
      costMicros: current.costMicros + row.cost_micros,
    };
  }

  return { calls, inputTokens, outputTokens, costMicros, since, until, byModel };
}

export class SqliteUsageStore implements UsageStore, GlobalUsageStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  async record(chatId: ChatId, event: UsageEvent): Promise<void> {
    if (event.chatId !== chatId) {
      throw new InvalidValueError(
        `usage event belongs to chat ${String(event.chatId)}, not ${String(chatId)}`,
      );
    }
    this.#db
      .prepare(
        `INSERT INTO usage_events
           (id, ts, chat_id, thread_id, user_id, model, phase, input_tokens, output_tokens,
            cost_micros, unit_prices_json, range_spec, question_hash, status)
         VALUES
           (@id, @ts, @chatId, @threadId, @userId, @model, @phase, @inputTokens, @outputTokens,
            @costMicros, @unitPricesJson, @rangeSpec, @questionHash, @status)`,
      )
      .run({
        id: event.id,
        ts: toEpochMillis(event.ts),
        chatId,
        threadId: event.threadId,
        userId: encodeUserRef(event.user),
        model: event.model,
        phase: event.phase,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costMicros: event.costMicros,
        unitPricesJson: JSON.stringify(event.unitPrices),
        rangeSpec: event.rangeSpec,
        questionHash: event.questionHash,
        status: event.status,
      });
    await Promise.resolve();
  }

  async countCalls(chatId: ChatId, since: Temporal.Instant, until: Temporal.Instant): Promise<number> {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE chat_id = @chatId AND ts >= @since AND ts <= @until')
      .get({ chatId, since: toEpochMillis(since), until: toEpochMillis(until) }) as { n: number };
    return await Promise.resolve(row.n);
  }

  async summarize(chatId: ChatId, since: Temporal.Instant, until: Temporal.Instant): Promise<UsageSummary> {
    const rows = this.#db
      .prepare('SELECT * FROM usage_events WHERE chat_id = @chatId AND ts >= @since AND ts <= @until')
      .all({ chatId, since: toEpochMillis(since), until: toEpochMillis(until) }) as UsageEventRow[];
    return await Promise.resolve(summarizeRows(rows, since, until));
  }

  async anonymiseUser(chatId: ChatId, userId: UserId, token: string): Promise<number> {
    const info = this.#db
      .prepare(
        'UPDATE usage_events SET user_id = @newValue WHERE chat_id = @chatId AND user_id = @oldValue',
      )
      .run({
        chatId,
        oldValue: `${REAL_USER_PREFIX}${String(userId)}`,
        newValue: `${ANONYMISED_PREFIX}${token}`,
      });
    return await Promise.resolve(info.changes);
  }

  async deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const info = this.#db
      .prepare('DELETE FROM usage_events WHERE chat_id = @chatId AND ts < @cutoff')
      .run({ chatId, cutoff: toEpochMillis(cutoff) });
    return await Promise.resolve(info.changes);
  }

  async deleteChat(chatId: ChatId): Promise<number> {
    const info = this.#db.prepare('DELETE FROM usage_events WHERE chat_id = @chatId').run({ chatId });
    return await Promise.resolve(info.changes);
  }

  /* ------------------------ the deliberate global half ------------------- */

  async costMicrosSince(since: Temporal.Instant): Promise<number> {
    const row = this.#db
      .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS total FROM usage_events WHERE ts >= @since')
      .get({ since: toEpochMillis(since) }) as { total: number };
    return await Promise.resolve(row.total);
  }

  async summarizeGlobal(since: Temporal.Instant, until: Temporal.Instant): Promise<UsageSummary> {
    const rows = this.#db
      .prepare('SELECT * FROM usage_events WHERE ts >= @since AND ts <= @until')
      .all({ since: toEpochMillis(since), until: toEpochMillis(until) }) as UsageEventRow[];
    return await Promise.resolve(summarizeRows(rows, since, until));
  }
}
