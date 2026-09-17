/**
 * Per-chat daily call cap (DESIGN §9: "Daily caps | per-chat call count …").
 *
 * Reads through `UsageStore.countCalls`, so unlike the cooldown and
 * concurrency guards this one is *not* in-memory — a restart must not reset a
 * chat's daily count, or the cap stops meaning anything on a day with a
 * redeploy.
 *
 * The "day" is the UTC calendar day. DESIGN §9 only specifies the boundary
 * for the *global* budget ("refuses everything until midnight"); there is no
 * chat-local timezone signal available to a per-chat cap that would not
 * require threading `Config.forChat` through every caller, so both guards in
 * this directory share the same UTC-midnight definition of "day" for
 * consistency between the two caps a chat can hit.
 */
import { DailyCapError } from '../../domain/errors.js';
import type { Temporal } from '../../domain/time/temporal.js';
import type { ChatId } from '../../domain/model/ids.js';
import type { UsageStore } from '../ports/driven/usage-store.js';

/** Midnight UTC on the calendar day containing `now`. */
export function startOfUtcDay(now: Temporal.Instant): Temporal.Instant {
  return now.toZonedDateTimeISO('UTC').startOfDay().toInstant();
}

/**
 * Throws `DailyCapError` when the chat has already made `dailyCallsPerChat`
 * calls since UTC midnight. A call that is about to be refused for some other
 * reason (cooldown, concurrency) never reaches this check in the guarded
 * pipeline's ordering, so a refused call never counts against the cap here —
 * this only ever sees calls that got far enough to be recorded by the usage
 * writer.
 */
export async function assertUnderDailyCap(
  usage: UsageStore,
  chatId: ChatId,
  now: Temporal.Instant,
  dailyCallsPerChat: number,
): Promise<void> {
  const since = startOfUtcDay(now);
  const calls = await usage.countCalls(chatId, since, now);
  if (calls >= dailyCallsPerChat) {
    throw new DailyCapError(dailyCallsPerChat);
  }
}
