/**
 * The top-level rendering pipeline (DESIGN §6.5, §6.6, §6.8, §2, §4, §9):
 * turns a structured `Answer` into one or more ready-to-send Telegram HTML
 * strings.
 *
 * Order matters and is deliberate:
 *
 * 1. Slur substitution (DESIGN §6.6) runs on *plain* text, before anything
 *    is turned into markup — it has no business parsing HTML.
 * 2. `sanitizeToTelegramHtml` (DESIGN §6.5) neutralises mentions, strips
 *    `tg://` links, and reduces to the `<b>/<i>/<code>` allowlist, escaping
 *    everything else. Every piece of text that came from the model, or from
 *    Telegram (a topic label), goes through this — nothing downstream
 *    trusts it again.
 * 3. The header (`header.ts`) and footer (`footer.ts`) are composed around
 *    the sanitized body — the header's own template markup is ours, not
 *    user content, so it does not need step 1 or 2 applied to itself, only
 *    to the one untrusted substring it carries (the topic label, handled in
 *    `header.ts`).
 * 4. `splitHtmlIntoParts` (DESIGN §1, §8) cuts the assembled, well-formed
 *    HTML into 4096-char, tag-balanced parts.
 */
import { buildFooter } from './footer.js';
import { buildHeader } from './header.js';
import { sanitizeToTelegramHtml } from './html.js';
import type { RenderLanguage } from './language.js';
import { splitHtmlIntoParts } from './split.js';
import type { SplitOptions } from './split.js';
import { substituteSlurs } from './slurs.js';
import type { SlurWordlist } from './slurs.js';
import type { Answer } from '../model/answer.js';

const SECTION_LABEL: Readonly<
  Record<RenderLanguage, { readonly keyPoints: string; readonly unanswered: string }>
> = {
  pl: { keyPoints: 'Kluczowe punkty', unanswered: 'Bez odpowiedzi' },
  en: { keyPoints: 'Key points', unanswered: 'Unanswered' },
};

const TRUNCATION_NOTICE: Readonly<Record<RenderLanguage, string>> = {
  pl: '\n\n<i>… (skrócono)</i>',
  en: '\n\n<i>… (truncated)</i>',
};

export interface RenderOptions {
  readonly language: RenderLanguage;
  /** DESIGN §6.6, §10: the chat's `safety.slurs` wordlist. */
  readonly slurWordlist: SlurWordlist;
  readonly maxChars?: SplitOptions['maxChars'];
  readonly maxParts?: SplitOptions['maxParts'];
}

/** Slur substitution, then allowlist sanitisation — the fixed order untrusted text always goes through. */
function renderUntrusted(raw: string, slurWordlist: SlurWordlist): string {
  return sanitizeToTelegramHtml(substituteSlurs(raw, slurWordlist));
}

function renderBulletList(items: readonly string[], slurWordlist: SlurWordlist): string {
  return items.map((item) => `• ${renderUntrusted(item, slurWordlist)}`).join('\n');
}

function renderSection(title: string, items: readonly string[], slurWordlist: SlurWordlist): string | null {
  if (items.length === 0) return null;
  return `<b>${title}:</b>\n${renderBulletList(items, slurWordlist)}`;
}

/**
 * Renders one `Answer` into one or more Telegram-ready HTML parts, each
 * 1–`maxChars` characters (default 4096, DESIGN §1) and each independently
 * valid, well-formed HTML — the guarantee `ChatGateway.sendText` depends on
 * (DESIGN §3: "the domain does not render, ever" is the adapter's half;
 * this is the half that does).
 */
export function renderAnswer(answer: Answer, options: RenderOptions): string[] {
  const { content, meta } = answer;
  const labels = SECTION_LABEL[options.language];

  const blocks: string[] = [
    buildHeader(meta, content.tone, options.language),
    renderUntrusted(content.summary, options.slurWordlist),
  ];

  const keyPoints = renderSection(labels.keyPoints, content.keyPoints, options.slurWordlist);
  if (keyPoints !== null) blocks.push(keyPoints);

  const unanswered = renderSection(labels.unanswered, content.unanswered, options.slurWordlist);
  if (unanswered !== null) blocks.push(unanswered);

  blocks.push(buildFooter(options.language));

  const assembled = blocks.join('\n\n');
  return splitHtmlIntoParts(assembled, {
    maxChars: options.maxChars,
    maxParts: options.maxParts,
    truncationNotice: TRUNCATION_NOTICE[options.language],
  });
}
