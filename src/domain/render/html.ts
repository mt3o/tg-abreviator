/**
 * Telegram HTML rendering — the strict allowlist (DESIGN §6.5).
 *
 * "HTML with a strict allowlist (`<b>`, `<i>`, `<code>`), everything else
 * escaped; `tg://` links stripped; `@` mentions neutralised; link previews
 * off." Model output is untrusted (DESIGN §6, preamble: "Every message fed to
 * the model is written by someone who may be hostile, and the *question* is
 * untrusted too"), so this module treats every string handed to it as
 * hostile: unbalanced tags, stray `<script>`, a raw `tg://` deep link, an
 * `@everyone`-shaped mention, twenty thousand characters of noise.
 *
 * The output guarantee this file exists for: whatever comes in,
 * `sanitizeToTelegramHtml` always returns **well-formed** Telegram HTML —
 * every emitted tag is one of the three allowed names, and every opened tag
 * is closed, in the right order, by the time the string ends. Nothing
 * downstream (the splitter, the gateway) has to re-verify that.
 */

/** The only tags DESIGN §6.5 allows through. */
export const ALLOWED_TAGS = ['b', 'i', 'code'] as const;
export type AllowedTag = (typeof ALLOWED_TAGS)[number];

function isAllowedTag(name: string): name is AllowedTag {
  return (ALLOWED_TAGS as readonly string[]).includes(name);
}

/** `&` first, or a literal `&` would be double-escaped by the entities it introduces. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * DESIGN §6.5: `tg://` deep links are stripped outright — they can target
 * bot-internal actions (e.g. `tg://user?id=...`), not just open a browser.
 * Removing the scheme leaves inert text behind rather than a live link.
 */
export function stripTgLinks(text: string): string {
  return text.replace(/tg:\/\//gi, '');
}

/**
 * DESIGN §6.5: `@` mentions neutralised. Telegram auto-links `@word` into a
 * mention from the plain text itself, independently of any HTML tag, so the
 * fix has to live in the text: a zero-width space split right after the `@`
 * reads identically to a human but breaks Telegram's mention entity
 * detection, which requires the username to immediately follow `@`.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(\w+)/gu, '@​$1');
}

/** Both content-level neutralisations DESIGN §6.5 requires, applied together. */
export function neutralizeContent(text: string): string {
  return neutralizeMentions(stripTgLinks(text));
}

/**
 * Matches any HTML-tag-shaped substring: `<b>`, `</code>`, `<script>`,
 * `<b style="x">`, `< b>` (no — that last one is deliberately *not* matched;
 * no whitespace is permitted between `<`/`</` and the tag name, matching how
 * Telegram's own parser is strict about tag shape).
 */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)\s*>/g;

/**
 * A hostile input can open the same allowed tag thousands of times with no
 * matching close (`'<b>'.repeat(3000)`). Nothing downstream — Telegram's own
 * renderer, or `split.ts` carrying open tags across a part boundary —
 * benefits from unbounded nesting, and `split.ts` specifically relies on
 * "the markup needed to keep every currently-open tag open" staying small
 * relative to a part's size budget. Capping depth here, at the one place
 * that ever pushes onto the stack, is what makes that a safe assumption
 * everywhere else instead of a hope.
 */
const MAX_NESTING_DEPTH = 20;

/**
 * Turns arbitrary text into well-formed Telegram HTML using only `<b>`,
 * `<i>`, `<code>`.
 *
 * Rules, in order of precedence:
 * - A tag whose name is not one of the three allowed ones is not a tag at
 *   all here — its literal `<`/`>` are escaped, same as any stray bracket.
 * - An allowed tag name carrying attributes (`<b style="x">`) is likewise
 *   treated as not a tag — the allowlist has no attribute grammar.
 * - A bare allowed opening tag pushes onto a stack and is emitted as-is.
 * - A bare allowed closing tag is only ever emitted when it matches the
 *   *top* of the stack (proper nesting); anything else — a stray close, a
 *   close for a tag that is not currently open, a close that skips over an
 *   inner open tag — is escaped as literal text instead of being trusted to
 *   close something. This is what makes the output always well-formed: a
 *   close is never emitted unless it is known to match.
 * - Anything left open when the input ends is closed automatically, in
 *   reverse order of opening.
 */
export function balanceAllowedTags(text: string): string {
  TAG_PATTERN.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  const stack: AllowedTag[] = [];
  let match: RegExpExecArray | null;

  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const [full, closeFlag, tagNameRaw, attrs] = match;
    result += escapeHtmlText(text.slice(lastIndex, match.index));
    lastIndex = match.index + full.length;

    const tagName = (tagNameRaw ?? '').toLowerCase();
    const hasAttrs = (attrs ?? '').trim().length > 0;

    if (isAllowedTag(tagName) && !hasAttrs) {
      if (closeFlag === '/') {
        if (stack.length > 0 && stack[stack.length - 1] === tagName) {
          stack.pop();
          result += `</${tagName}>`;
        } else {
          result += escapeHtmlText(full);
        }
      } else if (stack.length < MAX_NESTING_DEPTH) {
        stack.push(tagName);
        result += `<${tagName}>`;
      } else {
        // Depth cap reached: treat this open as if it were disallowed rather
        // than grow the stack further.
        result += escapeHtmlText(full);
      }
    } else {
      result += escapeHtmlText(full);
    }
  }
  result += escapeHtmlText(text.slice(lastIndex));

  while (stack.length > 0) {
    const tagName = stack.pop();
    result += `</${String(tagName)}>`;
  }

  return result;
}

/**
 * The full pipeline for one span of untrusted text: neutralise, then
 * allowlist-sanitise. Slur substitution (DESIGN §6.6) is a separate,
 * earlier step (`slurs.ts`) — it has to run on the *plain* text, before tag
 * balancing turns any of it into markup.
 */
export function sanitizeToTelegramHtml(rawText: string): string {
  return balanceAllowedTags(neutralizeContent(rawText));
}
