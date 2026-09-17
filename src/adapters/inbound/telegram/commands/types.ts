/**
 * Shared types for the command handlers (DESIGN §2, §3).
 *
 * Every handler gets the same three things: the already-built
 * `InvocationContext` (chat, thread, invoker + resolved tier, the *full* raw
 * argument string, the receive instant), the command-specific argument
 * string (whatever followed the command/subcommand keyword, trimmed to its
 * own remainder — see `commands/route.ts`), and the driven/driving ports it
 * needs. Nothing here is Telegram-shaped: that boundary was already crossed
 * in `dispatch.ts`.
 */
import type { ChatGateway } from '../../../../application/ports/driven/chat-gateway.js';
import type { Clock } from '../../../../application/ports/driven/clock.js';
import type { Config } from '../../../../application/ports/driven/config.js';
import type { ErrorReporter } from '../../../../application/ports/driven/error-reporter.js';
import type { AnswerQuestion } from '../../../../application/ports/driving/answer-question.js';
import type { ForgetUser } from '../../../../application/ports/driving/forget-user.js';
import type { InvocationContext } from '../../../../application/ports/driving/invocation.js';
import type { PurgeChat } from '../../../../application/ports/driving/purge-chat.js';
import type { ReadUsage } from '../../../../application/ports/driving/read-usage.js';
import type { AnswerOutcome, SummarizeRange } from '../../../../application/ports/driving/summarize-range.js';
import type { UpdateChatSetting } from '../../../../application/ports/driving/update-chat-setting.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

/**
 * Everything a command handler is allowed to reach. Driving ports
 * (`SummarizeRange`, `ForgetUser`, …) are frozen Phase 0 interfaces — the
 * dispatcher is wired to real implementations only from Wave 3's composition
 * root; every test here supplies its own small fake or spy.
 */
export interface CommandDeps {
  readonly config: Config;
  readonly gateway: ChatGateway;
  readonly clock: Clock;
  readonly reporter: ErrorReporter;
  readonly summarizeRange: SummarizeRange;
  readonly answerQuestion: AnswerQuestion;
  readonly forgetUser: ForgetUser;
  readonly purgeChat: PurgeChat;
  readonly updateChatSetting: UpdateChatSetting;
  readonly readUsage: ReadUsage;
}

export interface CommandContext {
  readonly invocation: InvocationContext;
  /**
   * Whatever followed the command/subcommand keyword, trimmed of its leading
   * whitespace. Never `null` — an absent argument is `''`. For the bare
   * `/tldr …` range/question path this is the full argument string; for a
   * subcommand (`tz`, `model`, `dm`, `stats`, `config`) it has already had the
   * subcommand keyword itself removed.
   */
  readonly args: string;
  readonly deps: CommandDeps;
}

/** What a command handler did — for the dispatcher's outcome and for tests. */
export type CommandResult =
  | { readonly kind: 'replied' }
  | { readonly kind: 'delegated'; readonly outcome: AnswerOutcome };

export function languageOf(deps: CommandDeps): RenderLanguage {
  return deps.config.get('bot').language;
}

/** A one-line usage/confirmation string, indexed by `bot.language`. */
export type LocalizedText = Readonly<Record<RenderLanguage, string>>;
