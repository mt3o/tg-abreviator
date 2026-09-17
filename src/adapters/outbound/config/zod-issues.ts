/**
 * Turns a Zod validation failure into `ConfigIssue[]` (DESIGN §10, step 2).
 *
 * `config-layers` deliberately does not validate at runtime, so *this* file is
 * where a malformed layer becomes a readable, dotted-path message instead of a
 * `ZodError` stack trace. Kept separate from `config-layers-adapter.ts` so the
 * mapping itself is trivially testable in isolation.
 */
import type { ZodError } from 'zod';

import type { ConfigIssue } from '../../../domain/errors.js';

/**
 * @param error The failed `safeParse` result's `error`.
 * @param prefix Prepended to every path, e.g. the layer name (`file`, `env`),
 *   so two layers failing on the same key are still distinguishable.
 */
export function zodErrorToConfigIssues(error: ZodError, prefix?: string): ConfigIssue[] {
  return error.issues.map((issue) => {
    const dotted = issue.path.map((segment) => String(segment)).join('.');
    const path = prefix === undefined || prefix.length === 0 ? dotted : `${prefix}.${dotted}`;
    return { path: path.length > 0 ? path : (prefix ?? '(root)'), message: issue.message };
  });
}
