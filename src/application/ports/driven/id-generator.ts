/**
 * `IdGenerator` — random token for anonymisation (DESIGN §3, §5).
 *
 * A port, not an import, for the same reason as `Clock`: the anonymisation
 * token that `/forgetme` writes into `usage_events` must be reproducible in a
 * test, and the domain owns no randomness at all.
 *
 * DESIGN §5 is emphatic that `token()` must be *random*, not derived: a hash of
 * a Telegram user id is re-linkable across a small enumerable integer space, and
 * therefore is not erasure.
 */

export interface IdGenerator {
  /** Opaque unique id — `usage_events.id`, correlation ids. */
  uuid(): string;

  /**
   * Cryptographically random, URL-safe token. Used for the `/forgetme`
   * anonymisation value, which is stored nowhere else.
   */
  token(byteLength?: number): string;

  /**
   * Uniform integer in `[0, maxExclusive)`. Backs pseudonym label allocation
   * from the word list (DESIGN §11), so that `Math.random` never appears in
   * application code.
   */
  randomInt(maxExclusive: number): number;
}
