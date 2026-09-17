/**
 * `/forgetme` — the erasure cascade (DESIGN §2, §5, §11; member tier, and a
 * member may only erase themselves — there is no argument that could target
 * anyone else).
 */
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { ForgetUserResult } from '../../../../application/ports/driving/forget-user.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

function confirmationText(language: RenderLanguage, result: ForgetUserResult): string {
  if (language === 'pl') {
    return (
      `Gotowe. Usunięto ${String(result.messagesDeleted)} Twoich wiadomości i ` +
      `${String(result.chunksDeleted)} zależnych od nich podsumowań. ` +
      'Od teraz nic z tego czatu nie jest zapisywane na Twoje konto.'
    );
  }
  return (
    `Done. Deleted ${String(result.messagesDeleted)} of your messages and ` +
    `${String(result.chunksDeleted)} dependent chunk summaries. ` +
    'Nothing from this chat will be stored for you from now on.'
  );
}

export async function runForgetMe(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps } = ctx;
  const result = await deps.forgetUser.execute({
    chatId: invocation.chatId,
    userId: invocation.invoker.userId,
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
