/**
 * In-memory `UsageStore` and `GlobalUsageStore`.
 *
 * One object implements both ports, exactly as the SQLite adapter will: the
 * separation is about *how a caller asks* — a deliberate global aggregate
 * instead of an omitted `chatId` — not about where the rows live.
 */
import { Temporal } from '../../src/domain/time/temporal.js';
import type { ChatId, UserId } from '../../src/domain/model/ids.js';
import type {
  UsageEvent,
  UsageModelSummary,
  UsageSummary,
} from '../../src/domain/model/usage.js';
import type {
  GlobalUsageStore,
  UsageStore,
} from '../../src/application/ports/driven/usage-store.js';

const EMPTY_MODEL_SUMMARY: UsageModelSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

function withinWindow(event: UsageEvent, since: Temporal.Instant, until: Temporal.Instant): boolean {
  return (
    Temporal.Instant.compare(event.ts, since) >= 0 &&
    Temporal.Instant.compare(event.ts, until) <= 0
  );
}

function summarize(
  events: readonly UsageEvent[],
  since: Temporal.Instant,
  until: Temporal.Instant,
): UsageSummary {
  const byModel: Record<string, UsageModelSummary> = {};
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;

  for (const event of events) {
    calls += 1;
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    costMicros += event.costMicros;
    const current = byModel[event.model] ?? EMPTY_MODEL_SUMMARY;
    byModel[event.model] = {
      calls: current.calls + 1,
      inputTokens: current.inputTokens + event.inputTokens,
      outputTokens: current.outputTokens + event.outputTokens,
      costMicros: current.costMicros + event.costMicros,
    };
  }

  return { calls, inputTokens, outputTokens, costMicros, since, until, byModel };
}

export class FakeUsageStore implements UsageStore, GlobalUsageStore {
  readonly #rows = new Map<ChatId, UsageEvent[]>();

  async record(chatId: ChatId, event: UsageEvent): Promise<void> {
    if (event.chatId !== chatId) {
      throw new Error(
        `usage event belongs to chat ${String(event.chatId)}, not ${String(chatId)}`,
      );
    }
    this.#chat(chatId).push(event);
    await Promise.resolve();
  }

  async countCalls(
    chatId: ChatId,
    since: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<number> {
    const rows = this.#chat(chatId).filter((event) => withinWindow(event, since, until));
    return await Promise.resolve(rows.length);
  }

  async summarize(
    chatId: ChatId,
    since: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<UsageSummary> {
    const rows = this.#chat(chatId).filter((event) => withinWindow(event, since, until));
    return await Promise.resolve(summarize(rows, since, until));
  }

  async anonymiseUser(chatId: ChatId, userId: UserId, token: string): Promise<number> {
    const rows = this.#chat(chatId);
    let rewritten = 0;
    for (const [index, event] of rows.entries()) {
      if (event.user.kind !== 'user' || event.user.userId !== userId) continue;
      rows[index] = { ...event, user: { kind: 'anonymised', token } };
      rewritten += 1;
    }
    return await Promise.resolve(rewritten);
  }

  async deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const rows = this.#chat(chatId);
    const kept = rows.filter((event) => Temporal.Instant.compare(event.ts, cutoff) >= 0);
    const deleted = rows.length - kept.length;
    this.#rows.set(chatId, kept);
    return await Promise.resolve(deleted);
  }

  async deleteChat(chatId: ChatId): Promise<number> {
    const deleted = this.#chat(chatId).length;
    this.#rows.delete(chatId);
    return await Promise.resolve(deleted);
  }

  /* ------------------------ the deliberate global half ------------------- */

  async costMicrosSince(since: Temporal.Instant): Promise<number> {
    let total = 0;
    for (const rows of this.#rows.values()) {
      for (const event of rows) {
        if (Temporal.Instant.compare(event.ts, since) >= 0) total += event.costMicros;
      }
    }
    return await Promise.resolve(total);
  }

  async summarizeGlobal(
    since: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<UsageSummary> {
    const all: UsageEvent[] = [];
    for (const rows of this.#rows.values()) {
      all.push(...rows.filter((event) => withinWindow(event, since, until)));
    }
    return await Promise.resolve(summarize(all, since, until));
  }

  /* ---------------------------- test helpers ----------------------------- */

  knownChatIds(): readonly ChatId[] {
    return [...this.#rows.keys()];
  }

  dump(chatId: ChatId): readonly UsageEvent[] {
    return [...this.#chat(chatId)];
  }

  #chat(chatId: ChatId): UsageEvent[] {
    let rows = this.#rows.get(chatId);
    if (rows === undefined) {
      rows = [];
      this.#rows.set(chatId, rows);
    }
    return rows;
  }
}
