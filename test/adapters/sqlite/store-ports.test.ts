/**
 * WS1 DoD: "the Phase 0 port-conformance suite passes against SQLite exactly
 * as it does against the fakes." Reuses `runStorePortConformance` verbatim,
 * mirroring `test/fakes/store-ports.test.ts` for the real adapter.
 *
 * This file lives under `test/`, not `src/adapters/outbound/sqlite/`,
 * because the eslint import-boundary rules (DESIGN §3, CI-enforced) forbid
 * an `adapters` module from importing anything under `test/` — and this
 * suite's entire point is to import the frozen Phase 0 conformance harness
 * and the frozen fakes' `Clock`/`IdGenerator` verbatim. It touches no file
 * any other workstream owns.
 *
 * Every store lives behind one real file per test — WAL mode needs a real
 * file, never `:memory:` (DESIGN §3) — created fresh by the suite's own
 * factory and removed in `teardown`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStorePortConformance } from '../../conformance/all-stores.js';
import type { StorePortBundle } from '../../conformance/all-stores.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeIdGenerator } from '../../fakes/fake-id-generator.js';
import { closeDatabase, openDatabase } from '../../../src/adapters/outbound/sqlite/database.js';
import { createSqliteStores } from '../../../src/adapters/outbound/sqlite/stores.js';

runStorePortConformance('sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-abreviator-sqlite-conformance-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  const stores = createSqliteStores(db, { clock: new FakeClock(), ids: new FakeIdGenerator(7) });

  const store: StorePortBundle = {
    messages: stores.messages,
    chunks: stores.chunks,
    settings: stores.settings,
    optOuts: stores.optOuts,
    usage: stores.usage,
    globalUsage: stores.globalUsage,
    pollState: stores.pollState,
    pseudonyms: stores.pseudonyms,
  };

  return {
    store,
    teardown: () => {
      closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
