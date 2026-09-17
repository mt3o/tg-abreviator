/**
 * `/tldr <range> [question]` — the default path once `route.ts` has ruled
 * out every subcommand keyword. Parses the leading range token with WS3's
 * pure grammar and delegates to `SummarizeRange` when no question follows,
 * `AnswerQuestion` when one does — "range and intent are orthogonal"
 * (DESIGN §2).
 *
 * DESIGN §2: "Unparseable leading token → error + help, never a guess." A
 * range grammar error is therefore caught here and turned into a reply with a
 * hint to run `/tldr help`, rather than surfacing as an unexpected failure —
 * the same treatment `AnswerOutcome`'s `refused` case gets for guard/corpus
 * refusals below.
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { RangeInvocation } from '../../../../application/ports/driving/invocation.js';
import { isAppError } from '../../../../domain/errors.js';
import type { ErrorCode } from '../../../../domain/errors.js';
import { parse } from '../../../../domain/range/parse.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

function refusalText(
  language: RenderLanguage,
  code: ErrorCode,
  commandName: string,
  retryAfterSeconds: number | undefined,
): string {
  const c = escapeHtml(commandName);
  const table: Partial<Record<ErrorCode, Readonly<Record<RenderLanguage, string>>>> = {
    'guard.cooldown': {
      pl: 'Za szybko — poczekaj chwilę przed kolejnym zapytaniem.',
      en: 'Too soon — please wait before asking again.',
    },
    'guard.concurrent_request': {
      pl: 'W tym czacie trwa już inne zapytanie — poczekaj, aż się zakończy.',
      en: 'Another request is already running in this chat — wait for it to finish.',
    },
    'guard.daily_cap': {
      pl: 'Dzienny limit zapytań dla tego czatu został osiągnięty.',
      en: "This chat's daily call limit has been reached.",
    },
    'guard.budget_exhausted': {
      pl: 'Dzienny budżet bota został wyczerpany — spróbuj ponownie jutro.',
      en: "The bot's daily budget is exhausted for today — try again tomorrow.",
    },
    'corpus.empty': {
      pl: 'Brak zapisanych wiadomości w tym zakresie.',
      en: 'No stored messages in that range.',
    },
    'corpus.too_large': {
      pl: 'Ten zakres jest za duży — spróbuj węższego.',
      en: 'That range is too large — try a narrower one.',
    },
    'policy.refused': {
      pl: 'Nie mogę odpowiedzieć na to pytanie.',
      en: "I can't answer that question.",
    },
    'range.unparseable': {
      pl: `Nie rozumiem tego zakresu. Zobacz /${c} help.`,
      en: `I don't understand that range. See /${c} help.`,
    },
    'range.missing_unit': {
      pl: `Ta liczba potrzebuje jednostki (np. 2h). Zobacz /${c} help.`,
      en: `That number needs a unit (e.g. 2h). See /${c} help.`,
    },
    'range.out_of_bounds': {
      pl: 'Ten zakres przekracza dozwolony limit.',
      en: 'That range exceeds the permitted limit.',
    },
    'range.anchor_not_found': {
      pl: 'Nie mam już w bazie wiadomości, na którą odpowiadasz.',
      en: "I no longer have the message you replied to.",
    },
    'llm.rate_limited': {
      pl: 'Dostawca modelu jest chwilowo przeciążony — spróbuj za moment.',
      en: 'The model provider is temporarily overloaded — try again shortly.',
    },
  };
  const entry = table[code];
  const base =
    entry?.[language] ??
    (language === 'pl' ? 'Nie udało się zrealizować żądania.' : 'The request could not be completed.');
  if (retryAfterSeconds === undefined) return base;
  const suffix =
    language === 'pl' ? ` Spróbuj ponownie za ${String(retryAfterSeconds)}s.` : ` Try again in ${String(retryAfterSeconds)}s.`;
  return base + suffix;
}

export async function runRange(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps, args } = ctx;
  const language = languageOf(deps);
  const commandName = deps.config.get('bot').commandName;

  let parsed;
  try {
    parsed = parse(args);
  } catch (error) {
    if (!isAppError(error)) throw error;
    await deps.gateway.sendText(invocation.chatId, {
      text: refusalText(language, error.code, commandName, undefined),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  const rangeInvocation: RangeInvocation = { invocation, parsed };
  const outcome =
    parsed.question === null
      ? await deps.summarizeRange.execute(rangeInvocation)
      : await deps.answerQuestion.execute({ ...rangeInvocation, question: parsed.question });

  if (outcome.kind === 'refused') {
    await deps.gateway.sendText(invocation.chatId, {
      text: refusalText(language, outcome.code, commandName, outcome.retryAfterSeconds),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
  }

  return { kind: 'delegated', outcome };
}
