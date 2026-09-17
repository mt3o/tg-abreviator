/**
 * `/forget` — wipe the whole chat log (DESIGN §2, §5; chat-admin tier).
 */
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { PurgeChatResult } from '../../../../application/ports/driving/purge-chat.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

function confirmationText(language: RenderLanguage, result: PurgeChatResult): string {
  if (language === 'pl') {
    return (
      `Gotowe. Usunięto ${String(result.messagesDeleted)} wiadomości i ` +
      `${String(result.chunksDeleted)} podsumowań z tego czatu.`
    );
  }
  return (
    `Done. Deleted ${String(result.messagesDeleted)} messages and ` +
    `${String(result.chunksDeleted)} chunk summaries from this chat.`
  );
}

export async function runForget(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps } = ctx;
  const result = await deps.purgeChat.execute({
    chatId: invocation.chatId,
    requestedBy: invocation.invoker.userId,
    at: deps.clock.now(),
  });
  await deps.gateway.sendText(invocation.chatId, {
    text: confirmationText(languageOf(deps), result),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
