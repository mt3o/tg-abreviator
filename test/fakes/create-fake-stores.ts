/**
 * One call that hands a workstream every fake it needs.
 *
 * Kept out of any `*.test.ts` file on purpose: importing a test file to reuse a
 * helper re-registers that file's tests in the importer, which is how a suite
 * quietly starts running 54 extra tests in the wrong place.
 */
import { FakeChatGateway } from './fake-chat-gateway.js';
import { FakeChunkStore } from './fake-chunk-store.js';
import { FakeClock } from './fake-clock.js';
import { FakeConfig } from './fake-config.js';
import { FakeErrorReporter } from './fake-error-reporter.js';
import { FakeIdGenerator } from './fake-id-generator.js';
import { FakeLlm } from './fake-llm.js';
import { FakeMaintenanceStore } from './fake-maintenance-store.js';
import { FakeMessageStore } from './fake-message-store.js';
import { FakeOptOutStore } from './fake-opt-out-store.js';
import { FakePollStateStore } from './fake-poll-state-store.js';
import { FakePseudonymStore } from './fake-pseudonym-store.js';
import { FakeSettingsStore } from './fake-settings-store.js';
import { FakeUsageStore } from './fake-usage-store.js';
import type { StorePortBundle } from '../conformance/all-stores.js';

export interface FakeStores extends StorePortBundle {
  readonly messages: FakeMessageStore;
  readonly chunks: FakeChunkStore;
  readonly settings: FakeSettingsStore;
  readonly optOuts: FakeOptOutStore;
  readonly usage: FakeUsageStore;
  readonly globalUsage: FakeUsageStore;
  readonly pollState: FakePollStateStore;
  readonly pseudonyms: FakePseudonymStore;
  readonly maintenance: FakeMaintenanceStore;
}

export interface FakeEnvironment extends FakeStores {
  readonly clock: FakeClock;
  readonly ids: FakeIdGenerator;
  readonly gateway: FakeChatGateway;
  readonly llm: FakeLlm;
  readonly config: FakeConfig;
  readonly reporter: FakeErrorReporter;
}

export interface FakeEnvironmentOptions {
  readonly clock?: FakeClock;
  readonly ids?: FakeIdGenerator;
  readonly config?: FakeConfig;
}

/** Every driven store, wired to each other where the ports say they must be. */
export function createFakeStores(options: FakeEnvironmentOptions = {}): FakeStores {
  const clock = options.clock ?? new FakeClock();
  const ids = options.ids ?? new FakeIdGenerator(42);

  const messages = new FakeMessageStore();
  const chunks = new FakeChunkStore(messages);
  const settings = new FakeSettingsStore();
  const optOuts = new FakeOptOutStore();
  const usage = new FakeUsageStore();
  const pollState = new FakePollStateStore();
  const pseudonyms = new FakePseudonymStore(ids, clock);

  return {
    messages,
    chunks,
    settings,
    optOuts,
    usage,
    globalUsage: usage,
    pollState,
    pseudonyms,
    maintenance: new FakeMaintenanceStore(messages, chunks, settings, optOuts, usage, pseudonyms),
  };
}

/** The stores plus every other driven port: the whole outside world, faked. */
export function createFakeEnvironment(options: FakeEnvironmentOptions = {}): FakeEnvironment {
  const clock = options.clock ?? new FakeClock();
  const ids = options.ids ?? new FakeIdGenerator(42);
  return {
    ...createFakeStores({ clock, ids }),
    clock,
    ids,
    gateway: new FakeChatGateway(),
    llm: new FakeLlm(),
    config: options.config ?? new FakeConfig(),
    reporter: new FakeErrorReporter(),
  };
}
