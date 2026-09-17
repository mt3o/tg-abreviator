/**
 * The single place in the codebase where `Temporal` is imported.
 *
 * DESIGN §3 targets Node 26, where `Temporal` is a global. TypeScript does not
 * yet ship `lib` declarations for it, and the repo has to typecheck and test on
 * Node 22 LTS as well, so the polyfill is the source of both the types and the
 * runtime here. Swapping to the platform global later is a one-line change *in
 * this file* and nowhere else.
 *
 * Every other module — domain, application, adapters, tests — imports
 * `Temporal` from here:
 *
 * ```ts
 * import { Temporal } from '../time/temporal.js';
 * ```
 *
 * eslint enforces this (`no-restricted-imports`): importing `temporal-polyfill`
 * anywhere else is an error.
 *
 * Note also that nothing outside an adapter or a test may call `Temporal.Now`.
 * Time comes from the `Clock` port (DESIGN §3) so that TTLs, bucket boundaries
 * and dedupe windows are deterministic under test; eslint enforces that too.
 */
export { Temporal } from 'temporal-polyfill';

/** IANA time zone identifier, e.g. `Europe/Warsaw`. Validated at the edges. */
export type TimeZoneId = string;
