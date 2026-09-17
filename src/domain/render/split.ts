/**
 * Splitting (DESIGN §1, §8): "`sendMessage` text is 1–4096 chars … Output
 * length cap, splitting fallback." "The reduce step is instructed to stay
 * under ~3000 characters. Splitting is a safety net, not the normal path:
 * split on paragraph boundaries, never inside an HTML tag, 2–3 parts
 * maximum."
 *
 * This module is purely mechanical: it takes **already-sanitized** Telegram
 * HTML (only `<b>`, `<i>`, `<code>`, no attributes — exactly what
 * `sanitizeToTelegramHtml` and `renderAnswer` produce) and cuts it into
 * parts, each of which is independently valid, well-formed Telegram HTML no
 * longer than `maxChars`. A tag that spans a cut point is closed at the end
 * of one part and reopened at the start of the next, so "never inside a
 * tag" holds even for a single block of content longer than one part.
 */
import { ALLOWED_TAGS } from './html.js';
import type { AllowedTag } from './html.js';

export interface SplitOptions {
  /** Telegram's hard ceiling is 4096 (DESIGN §1); default matches it. */
  readonly maxChars?: number;
  /** DESIGN §8: "2-3 parts maximum". Default 3. */
  readonly maxParts?: number;
  /**
   * Appended, best-effort, to the last kept part when content had to be
   * dropped to respect `maxParts`. Only inserted when it fits within
   * `maxChars` — the length cap is never violated to make room for it.
   */
  readonly truncationNotice?: string;
}

type Token =
  | { readonly type: 'open'; readonly tag: AllowedTag }
  | { readonly type: 'close'; readonly tag: AllowedTag }
  | { readonly type: 'text'; readonly value: string };

const TOKEN_PATTERN = new RegExp(`<(/?)(${ALLOWED_TAGS.join('|')})>`, 'g');

/**
 * Tokenizes already-sanitized HTML. Any `<...>`-shaped substring that is not
 * one of the exact allowed tag literals cannot occur in sanitizer output (it
 * would already have been escaped to `&lt;...&gt;`), so it is treated as
 * plain text here rather than re-validated.
 */
function tokenize(html: string): Token[] {
  TOKEN_PATTERN.lastIndex = 0;
  const tokens: Token[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(html)) !== null) {
    const [full, closeFlag, tag] = match;
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: html.slice(lastIndex, match.index) });
    }
    tokens.push({ type: closeFlag === '/' ? 'close' : 'open', tag: tag as AllowedTag });
    lastIndex = match.index + full.length;
  }
  if (lastIndex < html.length) tokens.push({ type: 'text', value: html.slice(lastIndex) });
  return tokens;
}

interface PartRecord {
  text: string;
  /** Length of the trailing auto-close markup this part ends with, if any. */
  closingLen: number;
}

/** Finds the best cut point within `window` (a slice already at the budget boundary). */
function findCut(window: string): number {
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > 0) return paragraph + 2;
  const newline = window.lastIndexOf('\n');
  if (newline > 0) return newline + 1;
  const space = window.lastIndexOf(' ');
  if (space > 0) return space + 1;
  return window.length; // hard cut: no natural boundary in the whole budget
}

export function splitHtmlIntoParts(html: string, options: SplitOptions = {}): string[] {
  const maxChars = options.maxChars ?? 4096;
  const maxParts = options.maxParts ?? 3;
  if (maxChars < 1) throw new RangeError('maxChars must be at least 1');
  if (maxParts < 1) throw new RangeError('maxParts must be at least 1');

  const tokens = tokenize(html);
  const parts: PartRecord[] = [];
  const openStack: AllowedTag[] = [];
  let current = '';

  const reopened = (): string => openStack.map((tag) => `<${tag}>`).join('');
  const closingLiteral = (): string =>
    [...openStack]
      .reverse()
      .map((tag) => `</${tag}>`)
      .join('');
  /** `</tag>`.length without building the string — used on every budget check. */
  const closingLen = (): number => openStack.reduce((sum, tag) => sum + tag.length + 3, 0);

  /**
   * Room reserved, on top of whatever `current` already holds, for the
   * markup needed to close every currently-open tag — the longest possible
   * single addition (one more `<code>`/`</code>` pair) plus a little slack.
   * `html.ts` bounds nesting depth (`MAX_NESTING_DEPTH`), so this is
   * comfortably smaller than any real `maxChars`; the margin exists so that
   * a single `flush()` is always enough to make room for the next token,
   * with no retry loop needed.
   */
  const SAFETY_MARGIN = 16;

  /**
   * "If I flushed *right now*, would the pushed part fit?" — the invariant
   * every mutation below maintains before it happens, not after: it is
   * `current.length + closingLen()` that must stay `<= maxChars`, because
   * that is the length `flush()` actually pushes.
   */
  const wouldFit = (addedContentLen: number, addedCloseLen: number): boolean =>
    current.length + addedContentLen + closingLen() + addedCloseLen <= maxChars;

  /**
   * Closes off the current part and starts the next one by reopening
   * whatever is still logically open.
   *
   * This is the one piece of unconditional forward-progress logic the rest
   * of this function depends on to terminate: it guarantees that afterwards,
   * `current.length + closingLen() + SAFETY_MARGIN <= maxChars` — room for
   * one more token, whatever it is. When reopening everything would not
   * leave that room (pathologically deep nesting relative to a small
   * `maxChars`), the excess is abandoned — closed for real, appended to the
   * part just finished — rather than carried forward. A later `close` token
   * for an abandoned tag then finds no matching entry on the stack and is
   * silently dropped (see below), rather than emitting a stray, unbalanced
   * close.
   */
  const flush = (): void => {
    const closing = closingLiteral();
    parts.push({ text: current + closing, closingLen: closing.length });
    const candidate = reopened();
    if (candidate.length + closingLen() + SAFETY_MARGIN <= maxChars) {
      current = candidate;
    } else {
      openStack.length = 0;
      current = '';
    }
  };

  for (const token of tokens) {
    if (token.type === 'open') {
      const literal = `<${token.tag}>`;
      if (!wouldFit(literal.length, token.tag.length + 3)) flush();
      current += literal;
      openStack.push(token.tag);
      continue;
    }
    if (token.type === 'close') {
      // Nothing to close: either genuinely stray (should not happen for
      // sanitizer-produced input) or this tag was abandoned by `flush()`
      // above when it exceeded the carryable depth for this budget. Either
      // way, emitting it would produce an unmatched close.
      if (openStack[openStack.length - 1] !== token.tag) continue;
      // Closing a tag never makes "current + closingLen()" larger — the
      // content grows by exactly as much as closingLen() shrinks — so unlike
      // `open` this can never need a flush to stay within budget.
      current += `</${token.tag}>`;
      openStack.pop();
      continue;
    }

    // text token
    let text = token.value;
    while (text.length > 0) {
      const budget = maxChars - current.length - closingLen();
      if (budget <= 0) {
        flush();
        continue;
      }
      if (text.length <= budget) {
        current += text;
        break;
      }
      const window = text.slice(0, budget);
      const cut = findCut(window);
      // The break itself (blank line, newline, or space) is consumed by the
      // cut, not carried onto either side of it.
      current += text.slice(0, cut).replace(/[ \n]+$/, '');
      text = text.slice(cut);
      // Trailing whitespace at a paragraph/line cut belongs to the break
      // just consumed, not to the next part's opening line.
      text = text.replace(/^[ \n]+/, '');
      flush();
    }
  }
  parts.push({ text: current + closingLiteral(), closingLen: closingLiteral().length });

  if (parts.length <= maxParts) return parts.map((part) => part.text);

  const kept = parts.slice(0, maxParts);
  const lastIndex = kept.length - 1;
  const last = kept[lastIndex];
  if (last === undefined) return kept.map((part) => part.text);

  const notice = options.truncationNotice ?? '';
  if (notice.length > 0 && last.text.length + notice.length <= maxChars) {
    const insertAt = last.text.length - last.closingLen;
    const withNotice = last.text.slice(0, insertAt) + notice + last.text.slice(insertAt);
    kept[lastIndex] = { text: withNotice, closingLen: last.closingLen };
  }
  return kept.map((part) => part.text);
}
