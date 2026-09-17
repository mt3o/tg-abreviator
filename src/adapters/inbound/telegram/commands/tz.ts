/**
 * `/tldr tz <IANA>` — set the chat timezone (DESIGN §2, §10; chat-admin
 * tier). Validated as a real IANA zone before the write, via `Intl` — the
 * only zone validator the platform gives us without pulling in a dependency.
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

const USAGE: Readonly<Record<RenderLanguage, (commandName: string) => string>> = {
  pl: (c) => `Użycie: /${c} tz <strefa IANA>, np. /${c} tz Europe/Warsaw`,
  en: (c) => `Usage: /${c} tz <IANA zone>, e.g. /${c} tz Europe/Warsaw`,
};

const INVALID: Readonly<Record<RenderLanguage, (zone: string) => string>> = {
  pl: (zone) => `Nieznana strefa czasowa: ${zone}`,
  en: (zone) => `Unknown time zone: ${zone}`,
};

const CONFIRMED: Readonly<Record<RenderLanguage, (zone: string) => string>> = {
  pl: (zone) => `Strefa czasowa tego czatu ustawiona na ${zone}.`,
  en: (zone) => `This chat's timezone is now ${zone}.`,
};

export async function runTz(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps, args } = ctx;
  const language = languageOf(deps);
  const commandName = deps.config.get('bot').commandName;
  const zone = args.trim().split(/\s+/)[0] ?? '';

  if (zone.length === 0) {
    await deps.gateway.sendText(invocation.chatId, {
      text: USAGE[language](escapeHtml(commandName)),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  if (!isValidTimeZone(zone)) {
    await deps.gateway.sendText(invocation.chatId, {
      text: INVALID[language](escapeHtml(zone)),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  await deps.updateChatSetting.execute({
    chatId: invocation.chatId,
    change: { kind: 'timeZone', timeZone: zone },
    requestedBy: invocation.invoker.userId,
    at: deps.clock.now(),
  });

  await deps.gateway.sendText(invocation.chatId, {
    text: CONFIRMED[language](escapeHtml(zone)),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
