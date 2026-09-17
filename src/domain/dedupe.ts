/**
 * Dedupe identity (DESIGN §9, "Dedupe identity — exact match, deliberately").
 *
 * ```
 * normalize = trim → NFC → collapse whitespace → toLocaleLowerCase('pl') → strip trailing ?!.
 * key = sha256(chat_id ‖ thread_id ‖ raw_range_token ‖ normalized_question ‖ model ‖ prompt_version)
 * ```
 *
 * A **false positive** (a cached answer to a different question) is a silently
 * wrong answer; a **false negative** merely costs a call. The errors are not
 * symmetric, so this is exact-match, never fuzzy — `NFC` matters on its own,
 * because Polish diacritics arrive composed or decomposed depending on the
 * keyboard, and the same word from two devices must hash identically.
 *
 * `node:crypto` is deliberately reachable from the domain (see
 * `eslint.config.js`, `forbiddenInDomain`): the dedupe key is a pure hash with
 * no randomness and no side effect, so it stays here rather than behind a
 * port.
 *
 * Keyed on the **raw range token**, never the resolved window (DESIGN §9):
 * `/tldr 2h` twice three minutes apart resolves to two different windows and
 * would never hit if the key used the resolved range instead of the token the
 * user actually typed.
 */
import { createHash } from 'node:crypto';

import type { ChatId, ThreadId } from './model/ids.js';

/** The `‖` in the DESIGN §9 formula: a separator that cannot occur in any field. */
const FIELD_SEPARATOR = '␟';

/**
 * `trim → NFC → collapse whitespace → toLocaleLowerCase('pl') → strip trailing ?!.`
 *
 * Order is exactly as specified: normalizing case before stripping trailing
 * punctuation would be equivalent here, but collapsing whitespace has to
 * happen before the trailing-punctuation strip finds the real end of the
 * string, and `trim` has to run first or `\s+` collapsing would leave a
 * leading/trailing single space behind.
 */
export function normalizeQuestion(question: string): string {
  return question
    .trim()
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('pl')
    .replace(/[?!.]+$/u, '');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Everything DESIGN §9's dedupe key formula needs, and nothing it does not. */
export interface DedupeKeyInput {
  readonly chatId: ChatId;
  readonly threadId: ThreadId | null;
  /** The raw range token exactly as typed (`RangeSpec.raw`), never the resolved window. */
  readonly rawRangeToken: string;
  /** Verbatim, pre-normalization. `null` for a summarize call — there is no question. */
  readonly question: string | null;
  /** Concrete provider model id that would serve this call. */
  readonly model: string;
  readonly promptVersion: string;
}

/** `sha256(chat_id ‖ thread_id ‖ raw_range_token ‖ normalized_question ‖ model ‖ prompt_version)`. */
export function dedupeKey(input: DedupeKeyInput): string {
  const normalizedQuestion = input.question === null ? '' : normalizeQuestion(input.question);
  const fields = [
    String(input.chatId),
    input.threadId === null ? '' : String(input.threadId),
    input.rawRangeToken,
    normalizedQuestion,
    input.model,
    input.promptVersion,
  ];
  return sha256Hex(fields.join(FIELD_SEPARATOR));
}

/**
 * `usage_events.question_hash` (DESIGN §4): "store only the question hash,
 * never the text". Distinct from `dedupeKey` above — this hashes the
 * normalized question alone, with no chat/model/prompt-version salt, because
 * its job is an audit trail field, not a cache lookup key. `null` passes
 * through for a summarize call, which never had a question.
 */
export function hashQuestion(question: string | null): string | null {
  if (question === null) return null;
  return sha256Hex(normalizeQuestion(question));
}
