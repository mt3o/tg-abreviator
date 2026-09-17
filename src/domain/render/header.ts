/**
 * The header every answer carries (DESIGN §2: "Every answer carries a
 * header stating the resolved scope … A wrong guess must be visible."):
 * scope, range, message count, a cached marker (DESIGN §9), a gap
 * disclosure (DESIGN §4) and a `⚠️` on a heated tone (DESIGN §6.6).
 */
import { sanitizeToTelegramHtml } from './html.js';
import { describeMessageCount, describeRange } from './range-label.js';
import type { AnswerMeta, Tone } from '../model/answer.js';
import type { RenderLanguage } from './language.js';

function scopeLabel(meta: AnswerMeta, language: RenderLanguage): string | null {
  if (meta.scope.kind === 'all') return language === 'pl' ? 'Wszystkie wątki' : 'All topics';
  // Non-forum chats, and General in a forum, carry no topic label at all —
  // nothing useful to say, so the scope segment is simply omitted rather
  // than printing "Topic: General" for every ordinary group chat.
  if (meta.scope.threadId === null) return null;
  const label = meta.topicLabel !== null ? sanitizeToTelegramHtml(meta.topicLabel) : `#${String(meta.scope.threadId)}`;
  return language === 'pl' ? `Wątek: ${label}` : `Topic: ${label}`;
}

/**
 * DESIGN §9: "a served-from-cache answer is labelled `↺ odpowiedź sprzed N
 * min`". Rounded down to whole minutes; "0 min" is a legitimate label for an
 * answer served seconds after it was cached, not a bug.
 */
function cachedLine(meta: AnswerMeta, language: RenderLanguage): string | null {
  if (meta.cached === null) return null;
  const minutes = String(Math.max(0, Math.floor(meta.cached.ageMinutes)));
  return language === 'pl' ? `↺ odpowiedź sprzed ${minutes} min` : `↺ answered ${minutes} min ago`;
}

/**
 * DESIGN §4: "Any range overlapping a gap gets an explicit line in the
 * output. Silent holes destroy trust faster than missing features."
 */
function gapLine(meta: AnswerMeta, language: RenderLanguage): string | null {
  if (meta.gapCount <= 0) return null;
  const n = String(meta.gapCount);
  if (language === 'pl') {
    return meta.gapCount === 1
      ? `⚠️ 1 przerwa w logu w tym zakresie (bot był offline)`
      : `⚠️ ${n} przerwy w logu w tym zakresie (bot był offline)`;
  }
  return meta.gapCount === 1
    ? `⚠️ 1 gap in the log within this range (the bot was offline)`
    : `⚠️ ${n} gaps in the log within this range (the bot was offline)`;
}

/** DESIGN §6.6: "a heated exchange still gets a `⚠️` in the header." */
function toneWarning(tone: Tone): string {
  return tone === 'heated' ? '⚠️ ' : '';
}

/**
 * Builds the full header block, already sanitized (any untrusted substring
 * — the topic label — has gone through `sanitizeToTelegramHtml`), ready to
 * be joined with the rest of the message body.
 */
export function buildHeader(meta: AnswerMeta, tone: Tone, language: RenderLanguage): string {
  const scope = scopeLabel(meta, language);
  const range = describeRange(meta.spec, language);
  const count = describeMessageCount(meta.messageCount, language);
  const summaryLine = [scope, range, count].filter((part): part is string => part !== null).join(' · ');

  const lines: string[] = [`<b>${toneWarning(tone)}${summaryLine}</b>`];
  const cached = cachedLine(meta, language);
  if (cached !== null) lines.push(cached);
  const gap = gapLine(meta, language);
  if (gap !== null) lines.push(gap);

  return lines.join('\n');
}
