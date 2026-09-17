/**
 * `/tldr dm on|off` — per-user delivery preference (DESIGN §2, §8; member
 * tier, and only ever for the invoker themselves — there is no argument that
 * could target anyone else).
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

const USAGE: Readonly<Record<RenderLanguage, (commandName: string) => string>> = {
  pl: (c) => `Użycie: /${c} dm on|off`,
  en: (c) => `Usage: /${c} dm on|off`,
};

const CONFIRMED: Readonly<Record<RenderLanguage, (enabled: boolean) => string>> = {
  pl: (enabled) =>
    enabled
      ? 'Odpowiedzi będą teraz wysyłane na priv. Jeśli nie pisałeś/aś jeszcze do mnie /start, napisz — inaczej Telegram nie pozwoli mi wysłać wiadomości prywatnej.'
      : 'Odpowiedzi wracają na czat.',
  en: (enabled) =>
    enabled
      ? "Answers will now be sent by DM. If you haven't /start'ed a chat with me yet, do that first — otherwise Telegram won't let me message you privately."
      : 'Answers will be delivered in-chat again.',
};

export async function runDm(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps, args } = ctx;
  const language = languageOf(deps);
  const commandName = deps.config.get('bot').commandName;
  const word = args.trim().toLowerCase();

  let enabled: boolean;
  if (word === 'on') {
    enabled = true;
  } else if (word === 'off') {
    enabled = false;
  } else {
    await deps.gateway.sendText(invocation.chatId, {
      text: USAGE[language](escapeHtml(commandName)),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  await deps.updateChatSetting.execute({
    chatId: invocation.chatId,
    change: { kind: 'dmDelivery', enabled },
    requestedBy: invocation.invoker.userId,
    at: deps.clock.now(),
  });

  await deps.gateway.sendText(invocation.chatId, {
    text: CONFIRMED[language](enabled),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
