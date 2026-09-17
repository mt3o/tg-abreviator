/**
 * `/privacy` — what is stored, the TTL, the operator contact, how to erase
 * (DESIGN §2, §5, member tier).
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { ChatId } from '../../../../domain/model/ids.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

/** DESIGN §5: global default, per-chat override — the operator-only knob. */
function effectiveTtlDays(
  chatId: ChatId,
  retention: { readonly ttlDays: number; readonly perChatTtlDays: Readonly<Record<string, number>> },
): number {
  return retention.perChatTtlDays[String(chatId)] ?? retention.ttlDays;
}

function privacyText(ttlDays: number, operatorContact: string, language: RenderLanguage): string {
  const contact = escapeHtml(operatorContact);
  if (language === 'pl') {
    return [
      'Co przechowujemy: treść wiadomości tekstowych i podpisy pod mediami (nigdy same pliki), nadawcę, czas i wątek — wyłącznie w czatach dopisanych do listy dozwolonych.',
      `Jak długo: ${String(ttlDays)} dni od wiadomości, potem usuwane automatycznie.`,
      'Usunięcie wiadomości w Telegramie tego nie usuwa z naszej bazy — Telegram nie informuje botów o usunięciach, więc TTL jest jedynym mechanizmem zapominania.',
      'Twoje dane: /forgetme usuwa Twoje wiadomości, wyłącza dalsze zapisywanie i unieważnia Twój pseudonim w logu błędów.',
      `Pytania i prośby o usunięcie danych: ${contact}.`,
    ].join('\n');
  }
  return [
    'What is stored: text messages and media captions (never the files themselves), sender, time and thread — only from chats on the allowlist.',
    `For how long: ${String(ttlDays)} days from the message, then deleted automatically.`,
    'Deleting a message in Telegram does not remove it from our database — Telegram never tells a bot about a deletion, which is what the TTL is for.',
    'Your data: /forgetme deletes your messages, opts you out of future logging and invalidates your pseudonym in the error log.',
    `Questions and data-removal requests: ${contact}.`,
  ].join('\n');
}

export async function runPrivacy(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps } = ctx;
  const bot = deps.config.get('bot');
  const retention = deps.config.get('retention');
  const ttlDays = effectiveTtlDays(invocation.chatId, retention);
  await deps.gateway.sendText(invocation.chatId, {
    text: privacyText(ttlDays, bot.operatorContact, languageOf(deps)),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
