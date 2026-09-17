/**
 * Corpus assembly (DESIGN §3 "Corpus assembly and transcript formatting",
 * §4 "Gap markers", §4 "Media", §6.4 "Bot's own messages are excluded", WS10).
 *
 * Pure, deterministic, zero I/O: turns an already-ordered, already-filtered
 * slice of `StoredMessage` rows into the transcript text handed to the model,
 * plus the two counts the header needs (`AnswerMeta.messageCount`,
 * `AnswerMeta.gapCount`).
 *
 * "Already filtered" is doing real work in that sentence: thread scoping
 * (`ResolvedRange.scope`), the bot's own messages, and opted-out users are all
 * excluded *before* rows ever reach here — `MessageStore.fetchRange` applies
 * `ResolvedRange.scope` and `MessageQueryOptions.excludeUserIds` (DESIGN §6.3,
 * §6.4) at query time, which is precisely the point: this module never sees a
 * chat id, a store, or an opt-out list, so it cannot get any of that wrong.
 * Its own job is what is left once that filtering has already happened:
 * formatting, and the one exclusion decision that has nothing to do with
 * *who* stored a row and everything to do with *what kind* of row it is.
 *
 * Three kinds get special treatment; every other kind becomes an ordinary
 * `[HH:MM] Name: text` line:
 *
 * - `service` rows (join/leave notices, pin events, …) carry no human
 *   utterance and are dropped from the transcript entirely — consistent with
 *   `NON_HUMAN_MESSAGE_KINDS` (DESIGN §2: "`-N` counts stored human messages
 *   only … not service messages").
 * - `gap_marker` rows are **not** dropped. DESIGN §4: "Any range overlapping a
 *   gap gets an explicit line in the output. Silent holes destroy trust
 *   faster than missing features." A gap becomes a line the *model* sees too,
 *   not just a number surfaced later in the header — the model is told the
 *   corpus has a hole at that point in time, which is exactly what backs
 *   DESIGN §6 rule 13 ("never assert absence as fact").
 * - every other kind (`photo`, `sticker`, `poll`, …) becomes a bracketed
 *   placeholder, plus its caption when present — DESIGN §4, "Media": "store
 *   the caption and a `kind` placeholder. Never the file. A summary can say
 *   'Ola sent a photo' without you hosting anyone's pictures."
 *
 * `redacted` rows (DESIGN §6.2: the entire body matched a secret shape) are
 * rendered as a fixed `[redacted]` placeholder regardless of whatever the
 * stored `text` happens to hold — the point of the kind existing at all is
 * that nothing downstream, including this module, ever has to trust that
 * field for such a row.
 */
import type { Temporal, TimeZoneId } from '../time/temporal.js';
import type { MessageKind, StoredMessage } from '../model/message.js';

/**
 * Every kind that is neither `text`, `redacted`, `service` nor `gap_marker` —
 * i.e. every kind that becomes a bracketed placeholder. Deliberately a
 * `Partial` keyed by the full `MessageKind` union so that adding a new media
 * kind to `MESSAGE_KINDS` without adding a label here is a type error, not a
 * silent `[kind]` fallback discovered in production.
 */
const MEDIA_KIND_LABEL: Readonly<Record<Exclude<MessageKind, 'text' | 'redacted' | 'service' | 'gap_marker'>, string>> =
  Object.freeze({
    photo: 'photo',
    video: 'video',
    animation: 'GIF',
    audio: 'audio',
    voice: 'voice message',
    video_note: 'video note',
    document: 'file',
    sticker: 'sticker',
    poll: 'poll',
    location: 'location',
    contact: 'contact',
    dice: 'dice roll',
    game: 'game',
  });

/**
 * DESIGN §4: the explicit disclosure line a gap becomes. Deliberately a
 * fixed, English, model-facing string — not the localized wording
 * `render/header.ts` builds for the *user*-facing gap line (a different
 * audience, a different concern) and not the `GapMarkerInput.text` note
 * (which the port docs already say the renderer, not this module, turns into
 * user-facing wording).
 */
const GAP_DISCLOSURE_TEXT =
  '[gap in the log: the bot was offline for a period here — messages may be missing]';

/** DESIGN §4: `StoredMessage.userId` is `null` for synthetic rows; real human rows always carry a name or an id. */
const UNKNOWN_SPEAKER = 'unknown';

export interface AssembleCorpusOptions {
  /** DST-correct `[HH:MM]` formatting: the chat's IANA zone (DESIGN §3). */
  readonly timeZone: TimeZoneId;
}

export interface AssembledCorpus {
  /** Ready to hand to the model as the `<transcript>` user block, verbatim. */
  readonly transcript: string;
  /** DESIGN §2: human messages only — never the bot's own, never service rows, never a gap marker. */
  readonly messageCount: number;
  /** DESIGN §4: every gap marker present in the input, for the header's disclosure line. */
  readonly gapCount: number;
}

function formatTimestamp(ts: Temporal.Instant, timeZone: TimeZoneId): string {
  const zoned = ts.toZonedDateTimeISO(timeZone);
  const hh = String(zoned.hour).padStart(2, '0');
  const mm = String(zoned.minute).padStart(2, '0');
  return `${hh}:${mm}`;
}

function speakerName(message: StoredMessage): string {
  if (message.displayName !== null && message.displayName.trim().length > 0) {
    return message.displayName;
  }
  return message.userId !== null ? `user${String(message.userId)}` : UNKNOWN_SPEAKER;
}

function isMediaKind(
  kind: MessageKind,
): kind is Exclude<MessageKind, 'text' | 'redacted' | 'service' | 'gap_marker'> {
  return kind !== 'text' && kind !== 'redacted' && kind !== 'service' && kind !== 'gap_marker';
}

function bodyFor(message: StoredMessage): string {
  if (message.kind === 'redacted') return '[redacted]';
  if (message.kind === 'text') return message.text ?? '';
  if (isMediaKind(message.kind)) {
    const label = MEDIA_KIND_LABEL[message.kind];
    const caption =
      message.text !== null && message.text.trim().length > 0 ? `: ${message.text}` : '';
    return `[${label}]${caption}`;
  }
  // Unreachable for `service` / `gap_marker` — both are handled by the caller
  // before `bodyFor` is ever called for them.
  return '';
}

/**
 * `assembleCorpus(messages, options)` (WS10's DoD): deterministic given the
 * same input rows and time zone — no `Clock`, no randomness, no store call.
 * Callers pass rows in `MessageStore`'s canonical order (`compareMessages`);
 * this function trusts that order rather than re-sorting, so its output is a
 * pure, total function of its input.
 */
export function assembleCorpus(
  messages: readonly StoredMessage[],
  options: AssembleCorpusOptions,
): AssembledCorpus {
  const lines: string[] = [];
  let messageCount = 0;
  let gapCount = 0;

  for (const message of messages) {
    if (message.kind === 'service') continue;

    const timestamp = formatTimestamp(message.ts, options.timeZone);

    if (message.kind === 'gap_marker') {
      gapCount += 1;
      lines.push(`[${timestamp}] ${GAP_DISCLOSURE_TEXT}`);
      continue;
    }

    messageCount += 1;
    lines.push(`[${timestamp}] ${speakerName(message)}: ${bodyFor(message)}`);
  }

  return { transcript: lines.join('\n'), messageCount, gapCount };
}
