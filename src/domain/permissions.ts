/**
 * Permission tiers — the pure predicate half of `requireTier()` (DESIGN §2).
 *
 * `operator` (`OPERATOR_USER_IDS`, anything anywhere) > `chatAdmin`
 * (`getChatMember` -> `creator`/`administrator`) > `member`. The vocabulary
 * (`Tier`, `TIER_RANK`, `ChatMemberStatus`) is Phase 0's
 * (`src/domain/model/tier.ts`); this file is the actual guard, kept pure so it
 * is testable without a `ChatGateway` or a `Config` in sight — the
 * `getChatMember` lookup and the `OPERATOR_USER_IDS` read live in the
 * adapter (`dispatch.ts`), which hands this module only the tier it already
 * resolved.
 *
 * DESIGN §2's command table is reproduced here as `COMMAND_TIERS` — the
 * *minimum* tier each command requires — so that the tier-matrix test has one
 * place to check every command against every tier. `stats` is the one
 * exception the table cannot express on its own: a chat-scoped request needs
 * `chatAdmin`, a global one needs `operator`. `COMMAND_TIERS.stats` records the
 * floor (`chatAdmin`); `dispatch.ts` enforces the stricter bound itself once it
 * knows which scope was requested.
 */
import { PermissionDeniedError } from './errors.js';
import { TIER_RANK } from './model/tier.js';
import type { ChatMemberStatus, Tier } from './model/tier.js';
import type { UserId } from './model/ids.js';

/** True when `actual` meets or exceeds `required` (DESIGN §2's ordering). */
export function hasTier(actual: Tier, required: Tier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/** Throws `PermissionDeniedError` when `actual` does not meet `required`. */
export function requireTier(actual: Tier, required: Tier): void {
  if (!hasTier(actual, required)) {
    throw new PermissionDeniedError(required, actual);
  }
}

/**
 * `getChatMember`'s status, reduced to the two tiers it can ever produce.
 * `operator` is never derived from this — it comes only from
 * `OPERATOR_USER_IDS`, checked before this function is even reached (DESIGN
 * §2: "anything anywhere").
 */
export function tierFromChatMemberStatus(status: ChatMemberStatus): Tier {
  return status === 'creator' || status === 'administrator' ? 'chatAdmin' : 'member';
}

/** DESIGN §2: `operator` from `OPERATOR_USER_IDS`, anything anywhere. */
export function isOperator(userId: UserId, operatorUserIds: readonly UserId[]): boolean {
  return operatorUserIds.includes(userId);
}

/**
 * The commands the dispatcher recognises. `tldr` is the base command as
 * configured by `bot.commandName` (DESIGN §2: "invocation is always an
 * explicit command, and it is configurable"); the leading word of its
 * argument string selects one of the subcommands below, or — when it matches
 * none of them — a range/question invocation (`SummarizeRange` /
 * `AnswerQuestion`). `forgetme`, `privacy` and `forget` are their own,
 * unconfigurable Telegram commands (DESIGN §2's table lists them without a
 * `/tldr` prefix).
 */
export type CommandName =
  | 'tldr'
  | 'help'
  | 'forgetme'
  | 'privacy'
  | 'forget'
  | 'tz'
  | 'model'
  | 'dm'
  | 'stats'
  | 'config';

/**
 * DESIGN §2's command table, reproduced as the minimum tier each command
 * requires. `tldr` here is the bare range/question invocation ("/tldr …");
 * `stats`'s global scope needs the stricter `operator` bound, enforced by the
 * caller (see module docs).
 */
export const COMMAND_TIERS: Readonly<Record<CommandName, Tier>> = Object.freeze({
  tldr: 'member',
  help: 'member',
  forgetme: 'member',
  privacy: 'member',
  forget: 'chatAdmin',
  tz: 'chatAdmin',
  model: 'chatAdmin',
  dm: 'member',
  stats: 'chatAdmin',
  config: 'operator',
});
