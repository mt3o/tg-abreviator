/**
 * Seeded in-memory `IdGenerator` (DESIGN §3, §5).
 *
 * The `/forgetme` anonymisation token must be *random* in production — a hash of
 * a Telegram user id is re-linkable across a small enumerable integer space and
 * therefore is not erasure — and *reproducible* in a test, or the erasure
 * cascade cannot be asserted. Hence a seeded PRNG behind the same port.
 *
 * This is emphatically not for production use: `mulberry32` is fast and
 * deterministic, which is exactly what makes it unsuitable for a real token.
 */
import type { IdGenerator } from '../../src/application/ports/driven/id-generator.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FakeIdGenerator implements IdGenerator {
  #next: () => number;
  #counter = 0;
  readonly #seed: number;
  /** Every value handed out, in order, for assertions. */
  readonly issued: string[] = [];

  constructor(seed = 1) {
    this.#seed = seed;
    this.#next = mulberry32(seed);
  }

  uuid(): string {
    this.#counter += 1;
    const id = `00000000-0000-4000-8000-${this.#counter.toString(16).padStart(12, '0')}`;
    this.issued.push(id);
    return id;
  }

  token(byteLength = 16): string {
    let out = '';
    for (let i = 0; i < byteLength; i += 1) {
      out += Math.floor(this.#next() * 256)
        .toString(16)
        .padStart(2, '0');
    }
    this.issued.push(out);
    return out;
  }

  randomInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`maxExclusive must be a positive integer, got ${String(maxExclusive)}`);
    }
    return Math.floor(this.#next() * maxExclusive);
  }

  /** Back to the constructor seed: the same sequence comes out again. */
  reset(): void {
    this.#next = mulberry32(this.#seed);
    this.#counter = 0;
    this.issued.length = 0;
  }
}
