/**
 * In-memory `ErrorReporter`.
 *
 * Records `(error, context)` pairs so that WS8's central assertion — DESIGN
 * §11: no message text, question text, display name or raw id ever reaches the
 * sink — can be made against a real captured event rather than by inspection.
 *
 * `capture` also asserts the contract *the type system already states*, because
 * an adapter written in a hurry can still cast: the context is serialized and
 * checked for values that are neither a number, a boolean, nor one of the closed
 * unions. Anything surprising fails the test that captured it.
 */
import { safeMessageOf, shouldReport } from '../../src/domain/errors.js';
import type {
  ErrorContext,
  ErrorReporter,
} from '../../src/application/ports/driven/error-reporter.js';

export interface CapturedEvent {
  readonly error: unknown;
  readonly context: ErrorContext;
  /** What an adapter is permitted to send as the event message (DESIGN §11). */
  readonly safeMessage: string;
  /** Whether DESIGN §11's report/don't-report split says this should be sent. */
  readonly reportable: boolean;
}

export class FakeErrorReporter implements ErrorReporter {
  readonly events: CapturedEvent[] = [];
  flushes = 0;
  closed = false;

  capture(error: unknown, context: ErrorContext): void {
    this.events.push({
      error,
      context,
      safeMessage: safeMessageOf(error),
      reportable: shouldReport(error),
    });
  }

  async flush(_timeoutMs?: number): Promise<boolean> {
    this.flushes += 1;
    return await Promise.resolve(true);
  }

  async close(_timeoutMs?: number): Promise<boolean> {
    this.closed = true;
    return await Promise.resolve(true);
  }

  /* ---------------------------- test helpers ----------------------------- */

  /** Only the events DESIGN §11 says belong in the sink. */
  reportable(): readonly CapturedEvent[] {
    return this.events.filter((event) => event.reportable);
  }

  /**
   * Everything the sink would actually see, flattened to strings: the safe
   * message plus every context value. Assert on this, not on the error objects —
   * it is the payload, and the payload is what leaves the building.
   */
  emittedStrings(): readonly string[] {
    const out: string[] = [];
    for (const event of this.reportable()) {
      out.push(event.safeMessage);
      for (const value of Object.values(event.context)) {
        if (value !== undefined) out.push(String(value));
      }
    }
    return out;
  }

  /** True when nothing the sink would see contains `needle`. */
  neverEmitted(needle: string): boolean {
    return !this.emittedStrings().some((value) => value.includes(needle));
  }

  clear(): void {
    this.events.length = 0;
  }
}
