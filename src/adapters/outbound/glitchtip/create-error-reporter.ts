/**
 * Wiring point for `ErrorReporter` (DESIGN §11): GlitchTip when a DSN is
 * configured, the no-op adapter when it is not. Bootstrap calls this once,
 * with values read from the resolved `Config` — it never decides between the
 * two adapters itself.
 */
import { NoopErrorReporter } from '../noop-reporter.js';
import type { ErrorReporter } from '../../../application/ports/driven/error-reporter.js';
import type { GlitchTipOptions } from './glitchtip-reporter.js';
import { createGlitchTipReporter } from './glitchtip-reporter.js';

export type ErrorReporterOptions = Omit<GlitchTipOptions, 'dsn'> & {
  /** `null` (or unset `GLITCHTIP_DSN`) selects the no-op adapter (DESIGN §11). */
  readonly dsn: string | null;
};

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  if (options.dsn === null) return new NoopErrorReporter();
  return createGlitchTipReporter({ ...options, dsn: options.dsn });
}
