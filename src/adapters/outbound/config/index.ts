/**
 * Public entry point for the `config-layers` adapter (WS7).
 *
 * `src/bootstrap` imports `createConfig` and nothing else from this
 * directory — no `config-layers` type is re-exported, per DESIGN §3.
 */
export { createConfig } from './config-layers-adapter.js';
export type { CreateConfigOptions } from './config-layers-adapter.js';
