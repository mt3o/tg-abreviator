/**
 * `/tldr model <alias>` — set the chat's model (DESIGN §2, §7, §10;
 * chat-admin tier). Validated against the model registry before the write —
 * `UpdateChatSetting` gets a `ChatSettingChange` carrying only an alias that
 * is already known to exist.
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

const USAGE: Readonly<Record<RenderLanguage, (commandName: string) => string>> = {
  pl: (c) => `Użycie: /${c} model <alias>`,
  en: (c) => `Usage: /${c} model <alias>`,
};

const UNKNOWN: Readonly<Record<RenderLanguage, (alias: string, known: string) => string>> = {
  pl: (alias, known) => `Nieznany model: ${alias}. Dostępne: ${known}.`,
  en: (alias, known) => `Unknown model: ${alias}. Available: ${known}.`,
};

const CONFIRMED: Readonly<Record<RenderLanguage, (alias: string) => string>> = {
  pl: (alias) => `Model tego czatu ustawiony na ${alias}.`,
  en: (alias) => `This chat's model is now ${alias}.`,
};

export async function runModel(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps, args } = ctx;
  const language = languageOf(deps);
  const commandName = deps.config.get('bot').commandName;
  const alias = args.trim().split(/\s+/)[0] ?? '';

  if (alias.length === 0) {
    await deps.gateway.sendText(invocation.chatId, {
      text: USAGE[language](escapeHtml(commandName)),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  const registry = deps.config.get('models').registry;
  if (!(alias in registry)) {
    const known = Object.keys(registry).sort((a, b) => a.localeCompare(b)).join(', ');
    await deps.gateway.sendText(invocation.chatId, {
      text: UNKNOWN[language](escapeHtml(alias), escapeHtml(known)),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  await deps.updateChatSetting.execute({
    chatId: invocation.chatId,
    change: { kind: 'model', alias },
    requestedBy: invocation.invoker.userId,
    at: deps.clock.now(),
  });

  await deps.gateway.sendText(invocation.chatId, {
    text: CONFIRMED[language](escapeHtml(alias)),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
