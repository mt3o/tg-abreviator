/**
 * `ErrorReporter` — no-op adapter (DESIGN §11).
 *
 * Selected whenever `GLITCHTIP_DSN` is unset, so a contributor without a DSN
 * still gets a working bot, and so no test in this repository ever emits a
 * network call by accident. It discards everything it is given: no queueing,
 * no local logging of `error` or `context` (a well-meaning debug log here would
 * quietly recreate the exact laundering path DESIGN §11 exists to close).
 */
import type { ErrorContext, ErrorReporter } from '../../application/ports/driven/error-reporter.js';

export class NoopErrorReporter implements ErrorReporter {
  capture(_error: unknown, _context: ErrorContext): void {
    // Deliberately does nothing.
  }

  async flush(_timeoutMs?: number): Promise<boolean> {
    return await Promise.resolve(true);
  }

  async close(_timeoutMs?: number): Promise<boolean> {
    return await Promise.resolve(true);
  }
}

export function createNoopErrorReporter(): ErrorReporter {
  return new NoopErrorReporter();
}
