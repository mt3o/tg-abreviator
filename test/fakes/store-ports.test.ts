/**
 * The Phase 0 definition of done: `npm test` runs green with zero real
 * implementations. Everything exercised here is a fake, and the suite that
 * exercises it is the same one WS1 will point at SQLite.
 */
import { runStorePortConformance } from '../conformance/all-stores.js';
import { createFakeStores } from './create-fake-stores.js';

runStorePortConformance('in-memory fakes', () => ({ store: createFakeStores() }));
