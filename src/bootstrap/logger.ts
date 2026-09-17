/**
 * Process logging. Structured, level-controlled by `logging.level` (DESIGN
 * §10's `logging` section, overridable per deployment with `LOG_LEVEL`).
 *
 * DESIGN §5: "never log row contents". That is a standing rule for every call
 * site rather than something this module can enforce, but it is also why
 * `logging.logMessageContents` is a `z.literal(false)` in the schema — the
 * knob exists so the answer is auditable, not so it can be turned on.
 * Everything logged from `main.ts` is a lifecycle event: counts, paths and
 * phase names, never message text, questions or display names.
 */
import pino from 'pino';
import type { Logger } from 'pino';

import type { ResolvedConfig } from '../config/schema.js';

export type { Logger };

export function createLogger(level: ResolvedConfig['logging']['level']): Logger {
  return pino({ level, base: { name: 'tg-abreviator' } });
}
