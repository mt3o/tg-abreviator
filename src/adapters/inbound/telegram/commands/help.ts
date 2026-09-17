/**
 * `/tldr help` — the grammar reference (DESIGN §2, member tier).
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

function helpText(commandName: string, language: RenderLanguage): string {
  const c = escapeHtml(commandName);
  if (language === 'pl') {
    return [
      `Użycie: /${c} [zakres] [pytanie]`,
      '',
      'Zakres (opcjonalny, liczy się tylko pierwszy wyraz):',
      '  -50                  ostatnie 50 wiadomości',
      '  2h / 30m / 3d / 1w   ostatnie N godzin / minut / dni / tygodni',
      '  2026-09-15           od początku podanego dnia',
      '  wczoraj, dzisiaj, w ostatnim tygodniu   słowa czasu PL/EN',
      '  all                  obejmij wszystkie wątki forum',
      '  (brak)               domyślnie: ostatnie 2 dni, maks. 500 wiadomości',
      '',
      'Odpowiedź na wiadomość ustawia kotwicę zakresu; jawny zakres ma pierwszeństwo.',
      '',
      'Podkomendy:',
      `  /${c} help                 ta pomoc`,
      `  /${c} tz <strefa IANA>     (admin czatu) ustawia strefę czasową`,
      `  /${c} model <alias>        (admin czatu) ustawia model`,
      `  /${c} dm on|off            dostarczanie odpowiedzi na priv`,
      `  /${c} stats [global]       statystyki użycia`,
      '  /forgetme                 usuń swoje dane, wyłącz zapisywanie',
      '  /privacy                  co i jak długo przechowujemy',
      '  /forget                   (admin czatu) wyczyść cały log czatu',
    ].join('\n');
  }
  return [
    `Usage: /${c} [range] [question]`,
    '',
    'Range (optional; only the leading word counts):',
    '  -50                  last 50 messages',
    '  2h / 30m / 3d / 1w   last N hours / minutes / days / weeks',
    '  2026-09-15           since the start of that day',
    '  yesterday, today, last week   PL/EN time words',
    '  all                  include every forum topic',
    '  (none)               default: last 2 days, capped at 500 messages',
    '',
    'Replying to a message anchors the range there; an explicit range wins.',
    '',
    'Subcommands:',
    `  /${c} help                 this text`,
    `  /${c} tz <IANA zone>       (chat admin) set the chat timezone`,
    `  /${c} model <alias>        (chat admin) set the chat model`,
    `  /${c} dm on|off            deliver answers by DM`,
    `  /${c} stats [global]       usage stats`,
    '  /forgetme                 erase your data, opt out of future logging',
    '  /privacy                  what is stored and for how long',
    '  /forget                   (chat admin) wipe the whole chat log',
  ].join('\n');
}

export async function runHelp(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps } = ctx;
  const commandName = deps.config.get('bot').commandName;
  await deps.gateway.sendText(invocation.chatId, {
    text: helpText(commandName, languageOf(deps)),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
