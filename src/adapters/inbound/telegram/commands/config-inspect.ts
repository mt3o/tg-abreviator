/**
 * `/tldr config <key>` — operator-only, backed by `Config.inspect` (DESIGN
 * §10). Answers "why is this chat on Haiku?": which layer supplied the
 * resolved value, and what every layer had to say — read through the chat's
 * own derived view so the `chat` layer is part of the answer.
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { ConfigOrigin } from '../../../../application/ports/driven/config.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

const USAGE: Readonly<Record<RenderLanguage, (commandName: string) => string>> = {
  pl: (c) => `Użycie: /${c} config <klucz>, np. /${c} config models.default`,
  en: (c) => `Usage: /${c} config <key>, e.g. /${c} config models.default`,
};

function formatOrigin(origin: ConfigOrigin): string {
  const lines = [`${origin.path} = ${JSON.stringify(origin.value)}  (from: ${origin.layer})`];
  for (const candidate of origin.candidates) {
    const marker = candidate.active ? '*' : ' ';
    lines.push(`  ${marker} ${candidate.layer}: ${JSON.stringify(candidate.value)}`);
  }
  return escapeHtml(lines.join('\n'));
}

export async function runConfigInspect(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps, args } = ctx;
  const language = languageOf(deps);
  const commandName = deps.config.get('bot').commandName;
  const key = args.trim();

  if (key.length === 0) {
    await deps.gateway.sendText(invocation.chatId, {
      text: USAGE[language](escapeHtml(commandName)),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
    return { kind: 'replied' };
  }

  const chatConfig = await deps.config.forChat(invocation.chatId);
  const origin = chatConfig.inspect(key);
  await deps.gateway.sendText(invocation.chatId, {
    text: formatOrigin(origin),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
