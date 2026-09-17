/** In-memory `PollStateStore` — the single-row long-polling cursor. */
import type { PollState } from '../../src/domain/model/settings.js';
import type { PollStateStore } from '../../src/application/ports/driven/poll-state-store.js';

export class FakePollStateStore implements PollStateStore {
  #state: PollState | null = null;
  /** Every state ever written, in order: proves the offset only moves forward. */
  readonly writes: PollState[] = [];

  async load(): Promise<PollState | null> {
    return await Promise.resolve(this.#state);
  }

  async save(state: PollState): Promise<void> {
    this.#state = state;
    this.writes.push(state);
    await Promise.resolve();
  }

  async clear(): Promise<void> {
    this.#state = null;
    await Promise.resolve();
  }
}
