/**
 * `IdGenerator`, backed by `node:crypto` (DESIGN §3, adapter table:
 * `outbound/system`).
 *
 * DESIGN §5 is emphatic about `token()`: the `/forgetme` anonymisation value
 * must be **freshly random**, never derived from the user id. Telegram user
 * ids are a small enumerable integer space, so a deterministic hash would be
 * re-linkable and therefore would not be erasure. `randomBytes` is the whole
 * point of this adapter.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import type { IdGenerator } from '../../../application/ports/driven/id-generator.js';

export class RandomIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }

  /** Hex, like the seeded fake, so a value looks the same in prod and in a test. */
  token(byteLength = 16): string {
    return randomBytes(byteLength).toString('hex');
  }

  randomInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`maxExclusive must be a positive integer, got ${String(maxExclusive)}`);
    }
    return randomInt(maxExclusive);
  }
}
