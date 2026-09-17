/**
 * The whole store port-conformance suite behind one call.
 *
 * ```ts
 * runStorePortConformance('sqlite', async () => {
 *   const db = await openTemporaryDatabase();
 *   return { store: { messages: ..., chunks: ..., ... }, teardown: () => db.close() };
 * });
 * ```
 *
 * WS1 reuses this verbatim: "the Phase 0 port-conformance suite passes against
 * SQLite exactly as it does against the fakes" (PLAN, WS1 DoD). Nothing in here
 * knows what is behind the ports — that is the entire point, and it is also why
 * a disagreement between the fake and the real store is a test failure rather
 * than a production surprise.
 */
import type { ChunkStore } from '../../src/application/ports/driven/chunk-store.js';
import type { MessageStore } from '../../src/application/ports/driven/message-store.js';
import type { OptOutStore } from '../../src/application/ports/driven/opt-out-store.js';
import type { PollStateStore } from '../../src/application/ports/driven/poll-state-store.js';
import type { PseudonymStore } from '../../src/application/ports/driven/pseudonym-store.js';
import type { SettingsStore } from '../../src/application/ports/driven/settings-store.js';
import type {
  GlobalUsageStore,
  UsageStore,
} from '../../src/application/ports/driven/usage-store.js';

import { runChunkStoreConformance } from './chunk-store.conformance.js';
import { runMessageStoreConformance } from './message-store.conformance.js';
import { runOptOutStoreConformance } from './opt-out-store.conformance.js';
import { runPollStateStoreConformance } from './poll-state-store.conformance.js';
import { runPseudonymStoreConformance } from './pseudonym-store.conformance.js';
import { runSettingsStoreConformance } from './settings-store.conformance.js';
import { runUsageStoreConformance } from './usage-store.conformance.js';
import type { ConformanceFactory, ConformanceFixture } from './support.js';

export interface StorePortBundle {
  readonly messages: MessageStore;
  readonly chunks: ChunkStore;
  readonly settings: SettingsStore;
  readonly optOuts: OptOutStore;
  readonly usage: UsageStore;
  readonly globalUsage: GlobalUsageStore;
  readonly pollState: PollStateStore;
  readonly pseudonyms: PseudonymStore;
}

/** Narrows a bundle factory to one port, keeping the teardown attached. */
function project<T>(
  factory: ConformanceFactory<StorePortBundle>,
  select: (bundle: StorePortBundle) => T,
): ConformanceFactory<T> {
  return async (): Promise<ConformanceFixture<T>> => {
    const fixture = await factory();
    return {
      store: select(fixture.store),
      teardown: (): Promise<void> | void => fixture.teardown?.(),
    };
  };
}

export function runStorePortConformance(
  label: string,
  factory: ConformanceFactory<StorePortBundle>,
): void {
  runMessageStoreConformance(label, project(factory, (bundle) => bundle.messages));
  runChunkStoreConformance(
    label,
    project(factory, (bundle) => ({ chunks: bundle.chunks, messages: bundle.messages })),
  );
  runSettingsStoreConformance(label, project(factory, (bundle) => bundle.settings));
  runOptOutStoreConformance(label, project(factory, (bundle) => bundle.optOuts));
  runUsageStoreConformance(
    label,
    project(factory, (bundle) => ({ usage: bundle.usage, global: bundle.globalUsage })),
  );
  runPollStateStoreConformance(label, project(factory, (bundle) => bundle.pollState));
  runPseudonymStoreConformance(label, project(factory, (bundle) => bundle.pseudonyms));
}
