/**
 * DELIBERATELY BROKEN. "No grammY type … may appear in src/domain or
 * src/application" (DESIGN §3) — and the way that rule erodes in practice is
 * exactly this: one innocent `import type`.
 *
 * Expected: no-restricted-imports
 */
import type { Context } from 'grammy';

export type LeakedContext = Context;
