/**
 * Permission tiers (DESIGN §2).
 *
 * `operator` (from `OPERATOR_USER_IDS`, anything anywhere) > `chatAdmin`
 * (`getChatMember` reports `creator` / `administrator`) > `member`.
 *
 * The tier *predicate* (`requireTier`) is WS6's `src/domain/permissions.ts`;
 * only the vocabulary lives here so that the ports can speak it.
 */

export type Tier = 'member' | 'chatAdmin' | 'operator';

/** Ordered weakest to strongest. Comparisons use `TIER_RANK`, never string order. */
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  member: 0,
  chatAdmin: 1,
  operator: 2,
});

/**
 * Telegram's chat member status, mapped to a domain vocabulary at the adapter
 * boundary so that no grammY type reaches the application layer (DESIGN §3).
 */
export type ChatMemberStatus =
  | 'creator'
  | 'administrator'
  | 'member'
  | 'restricted'
  | 'left'
  | 'kicked';
