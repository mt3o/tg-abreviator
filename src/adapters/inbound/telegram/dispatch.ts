/**
 * Command dispatcher (DESIGN §2, §3).
 *
 * "Dispatcher with a configurable command name, `@botname` suffix stripping,
 * and `bot_command` entity at offset 0 as the only trigger." Everything that
 * is not that — a service message, an ordinary sentence that happens to start
 * with a digit ("-5 stopni jutro"), a caption, a reply with no command of its
 * own — produces `{ kind: 'ignored' }` and touches nothing else. Telegram
 * itself decided whether a `bot_command` entity is present; there is no
 * guessing on top of that.
 *
 * Four Telegram commands are recognised: the configurable base command
 * (`bot.commandName`, default `tldr`) and three fixed ones DESIGN §2's table
 * lists without a `/tldr` prefix — `forgetme`, `privacy`, `forget`. The base
 * command's own leading argument word selects one of its subcommands
 * (`commands/route.ts`) or falls through to a range/question invocation
 * (`commands/range.ts`).
 *
 * Tier resolution: `operator` from `OPERATOR_USER_IDS` (DESIGN §2, "anything
 * anywhere"), checked first and without a network round trip; otherwise
 * `getChatMember` (`ChatGateway`, this workstream's one I/O dependency) maps
 * to `chatAdmin`/`member` via `tierFromChatMemberStatus`
 * (`src/domain/permissions.ts`). `requireTier()` then guards every command at
 * its `COMMAND_TIERS` floor; `stats`'s stricter `global` bound is enforced by
 * the handler itself (`commands/stats.ts`), which throws the same
 * `PermissionDeniedError` this dispatcher already knows how to turn into a
 * reply.
 */
import type { Message as TelegramMessage, Update, User as TelegramUser } from 'grammy/types';

import { runForget } from './commands/forget.js';
import { runForgetMe } from './commands/forgetme.js';
import { runPrivacy } from './commands/privacy.js';
import { resolveTldrCommand } from './commands/route.js';
import type { CommandContext, CommandDeps, CommandResult } from './commands/types.js';
import { languageOf } from './commands/types.js';
import type { InvocationContext, Invoker } from '../../../application/ports/driving/invocation.js';
import { PermissionDeniedError } from '../../../domain/errors.js';
import {
  asChatId,
  asMessageId,
  asOptionalThreadId,
  asUserId,
} from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { Tier } from '../../../domain/model/tier.js';
import { COMMAND_TIERS, isOperator, requireTier, tierFromChatMemberStatus } from '../../../domain/permissions.js';
import type { CommandName } from '../../../domain/permissions.js';
import { Temporal } from '../../../domain/time/temporal.js';

/* -------------------------------------------------------------------------- */
/* Extraction (DESIGN §2): a `bot_command` entity at offset 0, and nothing else. */
/* -------------------------------------------------------------------------- */

export interface ExtractedCommand {
  /** Lower-cased; no leading `/`, no `@botname` suffix. */
  readonly name: string;
  /** Everything after the command token, with only its leading whitespace stripped. */
  readonly rawArgs: string;
}

const COMMAND_TOKEN_PATTERN = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/;

/**
 * `null` for anything Telegram itself did not mark as a command at offset
 * 0 — including a command mid-message, one carried only in a caption, or one
 * explicitly addressed `@some_other_bot` in the same group.
 */
export function extractCommandInvocation(
  message: TelegramMessage,
  botUsername: string | null,
): ExtractedCommand | null {
  const text = message.text;
  if (text === undefined) return null;

  const entities = message.entities ?? [];
  const entity = entities.find((candidate) => candidate.type === 'bot_command' && candidate.offset === 0);
  if (entity === undefined) return null;

  const token = text.slice(0, entity.length);
  const match = COMMAND_TOKEN_PATTERN.exec(token);
  if (match === null) return null;

  const mentionedBot = match[2];
  if (
    mentionedBot !== undefined &&
    botUsername !== null &&
    mentionedBot.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }

  return {
    name: (match[1] ?? '').toLowerCase(),
    rawArgs: text.slice(entity.length).replace(/^\s+/, ''),
  };
}

function displayNameOf(user: TelegramUser): string | null {
  const parts = [user.first_name, user.last_name].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (parts.length > 0) return parts.join(' ');
  return user.username !== undefined ? `@${user.username}` : null;
}

/* -------------------------------------------------------------------------- */
/* Recognised commands                                                        */
/* -------------------------------------------------------------------------- */

interface ResolvedCommand {
  readonly name: CommandName;
  readonly args: string;
  readonly run: (ctx: CommandContext) => Promise<CommandResult>;
}

/** `null` for a syntactically valid command Telegram sent that this bot does not implement. */
function resolveCommand(extracted: ExtractedCommand, configuredBaseName: string): ResolvedCommand | null {
  if (extracted.name === configuredBaseName) return resolveTldrCommand(extracted.rawArgs);
  if (extracted.name === 'forgetme') return { name: 'forgetme', args: extracted.rawArgs, run: runForgetMe };
  if (extracted.name === 'privacy') return { name: 'privacy', args: extracted.rawArgs, run: runPrivacy };
  if (extracted.name === 'forget') return { name: 'forget', args: extracted.rawArgs, run: runForget };
  return null;
}

/* -------------------------------------------------------------------------- */
/* Outcome                                                                    */
/* -------------------------------------------------------------------------- */

export type DispatchOutcome =
  | {
      readonly kind: 'ignored';
      readonly reason:
        | 'not_a_message'
        | 'not_a_command'
        | 'unrecognized_command'
        | 'no_sender'
        | 'not_allowlisted';
    }
  | {
      readonly kind: 'denied';
      readonly command: CommandName;
      readonly requiredTier: Tier;
      readonly actualTier: Tier;
    }
  | { readonly kind: 'handled'; readonly command: CommandName; readonly result: CommandResult }
  | { readonly kind: 'failed'; readonly command: CommandName };

const INTERNAL_ERROR_TEXT: Readonly<Record<'pl' | 'en', string>> = {
  pl: 'Coś poszło nie tak po mojej stronie. Spróbuj ponownie za chwilę.',
  en: 'Something went wrong on my end. Please try again shortly.',
};

const TIER_LABEL: Readonly<Record<Tier, Readonly<Record<'pl' | 'en', string>>>> = {
  member: { pl: 'zwykłego użytkownika', en: 'member' },
  chatAdmin: { pl: 'administratora czatu', en: 'chat admin' },
  operator: { pl: 'operatora', en: 'operator' },
};

function permissionDeniedText(language: 'pl' | 'en', required: Tier): string {
  return language === 'pl'
    ? `Ta komenda wymaga uprawnień: ${TIER_LABEL[required].pl}.`
    : `This command requires ${TIER_LABEL[required].en} permissions.`;
}

/* -------------------------------------------------------------------------- */
/* The dispatcher                                                             */
/* -------------------------------------------------------------------------- */

export class CommandDispatcher {
  readonly #deps: CommandDeps;
  #botUserId: UserId | null = null;
  #botUsername: string | null = null;

  constructor(deps: CommandDeps) {
    this.#deps = deps;
  }

  /** Idempotent, like `TelegramPoller.start()` — resolves the bot's own identity once. */
  async start(): Promise<void> {
    if (this.#botUserId !== null) return;
    const identity = await this.#deps.gateway.getMe();
    this.#botUserId = identity.userId;
    this.#botUsername = identity.username;
  }

  async dispatch(update: Update): Promise<DispatchOutcome> {
    const message = update.message;
    if (message === undefined) return { kind: 'ignored', reason: 'not_a_message' };

    await this.start();

    const extracted = extractCommandInvocation(message, this.#botUsername);
    if (extracted === null) return { kind: 'ignored', reason: 'not_a_command' };

    const chatId = asChatId(message.chat.id);
    const allowlist = this.#deps.config.get('telegram').allowlist;
    if (!allowlist.includes(chatId)) return { kind: 'ignored', reason: 'not_allowlisted' };

    const from = message.from;
    if (from === undefined) return { kind: 'ignored', reason: 'no_sender' };

    const configuredBaseName = this.#deps.config.get('bot').commandName.toLowerCase();
    const resolved = resolveCommand(extracted, configuredBaseName);
    if (resolved === null) return { kind: 'ignored', reason: 'unrecognized_command' };

    const userId = asUserId(from.id);
    const tier = await this.#resolveTier(chatId, userId);

    const invoker: Invoker = { userId, displayName: displayNameOf(from), tier };
    const invocation: InvocationContext = {
      chatId,
      threadId: message.is_topic_message === true ? asOptionalThreadId(message.message_thread_id) : null,
      invokedMessageId: asMessageId(message.message_id),
      replyToMessageId:
        message.reply_to_message !== undefined && message.reply_to_message.message_id !== 0
          ? asMessageId(message.reply_to_message.message_id)
          : null,
      invoker,
      // The *full* argument string, exactly as extracted — not `resolved.args`,
      // which for a subcommand has already had its keyword stripped.
      rawArgs: extracted.rawArgs,
      receivedAt: Temporal.Instant.fromEpochMilliseconds(message.date * 1000),
    };

    try {
      requireTier(tier, COMMAND_TIERS[resolved.name]);
    } catch (error) {
      if (!(error instanceof PermissionDeniedError)) throw error;
      await this.#replyDenied(invocation, error);
      return {
        kind: 'denied',
        command: resolved.name,
        requiredTier: COMMAND_TIERS[resolved.name],
        actualTier: tier,
      };
    }

    const ctx: CommandContext = { invocation, args: resolved.args, deps: this.#deps };
    try {
      const result = await resolved.run(ctx);
      return { kind: 'handled', command: resolved.name, result };
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        await this.#replyDenied(invocation, error);
        return {
          kind: 'denied',
          command: resolved.name,
          requiredTier: error.requiredTier as Tier,
          actualTier: tier,
        };
      }
      this.#deps.reporter.capture(error, { phase: 'dispatch' });
      await this.#deps.gateway.sendText(chatId, {
        text: INTERNAL_ERROR_TEXT[languageOf(this.#deps)],
        threadId: invocation.threadId,
        replyToMessageId: invocation.invokedMessageId,
      });
      return { kind: 'failed', command: resolved.name };
    }
  }

  async #resolveTier(chatId: ChatId, userId: UserId): Promise<Tier> {
    const operatorIds = this.#deps.config.get('telegram').operatorUserIds.map((id) => asUserId(id));
    if (isOperator(userId, operatorIds)) return 'operator';
    const status = await this.#deps.gateway.getMemberStatus(chatId, userId);
    return tierFromChatMemberStatus(status);
  }

  async #replyDenied(invocation: InvocationContext, error: PermissionDeniedError): Promise<void> {
    const language = languageOf(this.#deps);
    await this.#deps.gateway.sendText(invocation.chatId, {
      text: permissionDeniedText(language, error.requiredTier as Tier),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
    });
  }
}
