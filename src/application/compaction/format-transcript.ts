/**
 * The default `<transcript>` text for one map-phase bucket (DESIGN §4, §7:
 * "formatting as `[HH:MM] Name: text`").
 *
 * This is deliberately minimal and self-contained: WS10 owns the *displayed*
 * corpus transcript (`src/domain/corpus/**`, with gap disclosure and the rest
 * of DESIGN §4's "Notes"), and a `CompactionRequest.formatBucket` override can
 * replace this with that richer renderer once it exists. Until then,
 * `Compactor` needs *some* deterministic way to turn a bucket of
 * `StoredMessage`s into text for the model, and this is it — plain, testable,
 * and using the same `[HH:MM] Name: text` shape DESIGN specifies, so a swap
 * later changes formatting, not the contract.
 */
import type { MessageKind, StoredMessage } from '../../domain/model/message.js';
import type { TimeZoneId } from '../../domain/time/temporal.js';

/** DESIGN §4: media is stored as a `kind` placeholder plus the caption, never the file. */
const KIND_PLACEHOLDER: Partial<Record<MessageKind, string>> = {
  photo: '[photo]',
  video: '[video]',
  animation: '[gif]',
  audio: '[audio]',
  voice: '[voice message]',
  video_note: '[video note]',
  document: '[document]',
  sticker: '[sticker]',
  poll: '[poll]',
  location: '[location]',
  contact: '[contact]',
  dice: '[dice]',
  game: '[game]',
  service: '[service message]',
  gap_marker: '[gap in the log]',
  redacted: '[redacted]',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLine(message: StoredMessage, timeZone: TimeZoneId): string {
  const zoned = message.ts.toZonedDateTimeISO(timeZone);
  const time = `${pad2(zoned.hour)}:${pad2(zoned.minute)}`;
  const name = message.displayName ?? '(unknown)';
  const placeholder = KIND_PLACEHOLDER[message.kind];
  const body =
    message.kind === 'text'
      ? (message.text ?? '')
      : [placeholder, message.text]
          .filter((part): part is string => part != null && part.length > 0)
          .join(' ');
  return `[${time}] ${name}: ${body}`;
}

/** One line per message, in the order given. Callers pass messages already in canonical order. */
export function defaultFormatTranscript(
  messages: readonly StoredMessage[],
  timeZone: TimeZoneId,
): string {
  return messages.map((message) => formatLine(message, timeZone)).join('\n');
}
