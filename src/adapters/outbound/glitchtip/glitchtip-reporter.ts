/**
 * `ErrorReporter` — GlitchTip adapter (DESIGN §11).
 *
 * GlitchTip is Sentry-compatible, so this is `@sentry/node` pointed at a
 * GlitchTip DSN. Every hardening rule in DESIGN §11 is applied at `init` time,
 * not left to whoever calls `capture()` later to remember:
 *
 * - `sendDefaultPii: false`.
 * - `beforeSend` is `scrubEvent` — drops `extra`/`contexts` wholesale, rewrites
 *   the exception message to the safe one, and rebuilds `tags` from the
 *   allowlist. See `scrub-event.ts` for the exhaustive test of what survives.
 * - Console and HTTP-body breadcrumbs are disabled by dropping the `Console`
 *   and `Http` default integrations, and `beforeBreadcrumb` drops every
 *   breadcrumb outright as a second line of defence.
 * - `release`, `environment` and `promptVersion` are tagged on every event —
 *   the first two are native Sentry event fields set here at `init`; the third
 *   has no native slot, so it travels as the `promptVersion` tag, defaulted by
 *   `buildTags` for the phases that never pass one explicitly.
 *
 * Errors whose *own message* may carry user content are the caller's problem
 * (DESIGN §11: wrap them in `RedactedError` before they reach `capture()`).
 * This adapter's job is to make sure that even an un-wrapped error cannot leak
 * — `scrubEvent` reads `safeMessageOf(hint.originalException)`, never
 * `error.message`, regardless of what the caller passed in.
 */
import * as Sentry from '@sentry/node';
import { shouldReport } from '../../../domain/errors.js';
import type {
  ErrorContext,
  ErrorReporter,
} from '../../../application/ports/driven/error-reporter.js';
import type { ResolvedConfig } from '../../../config/schema.js';
import { buildTags } from './tags.js';
import { scrubEvent } from './scrub-event.js';

export interface GlitchTipOptions {
  readonly dsn: string;
  readonly environment: ResolvedConfig['observability']['environment'];
  readonly release: string | null;
  readonly promptVersion: string;
  /**
   * Injection point for tests: overrides the default HTTP transport so a test
   * can exercise the full `init` → `capture` → `beforeSend` pipeline without
   * making a network call. Production callers omit it.
   */
  readonly transport?: Sentry.NodeOptions['transport'];
}

const DISABLED_DEFAULT_INTEGRATIONS = new Set(['Console', 'Http']);

export function createGlitchTipReporter(options: GlitchTipOptions): ErrorReporter {
  const client = Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release ?? undefined,
    sendDefaultPii: false,
    // DESIGN §11: console and HTTP-body breadcrumbs disabled.
    defaultIntegrations: Sentry.getDefaultIntegrationsWithoutPerformance().filter(
      (integration) => !DISABLED_DEFAULT_INTEGRATIONS.has(integration.name),
    ),
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });

  return {
    capture(error: unknown, context: ErrorContext): void {
      // DESIGN §11: a 429 with retry_after, a 403 on a DM, a bad range token —
      // metrics, not incidents. `scrubEvent` enforces this too (defence in
      // depth), but skipping the call outright means a non-reportable error
      // never even reaches the SDK's internal queue.
      if (!shouldReport(error)) return;
      Sentry.captureException(error, (scope) => {
        scope.setTags(buildTags(context, options.promptVersion));
        return scope;
      });
    },

    async flush(timeoutMs?: number): Promise<boolean> {
      if (client === undefined) return await Promise.resolve(true);
      return await client.flush(timeoutMs);
    },

    async close(timeoutMs?: number): Promise<boolean> {
      if (client === undefined) return await Promise.resolve(true);
      return await client.close(timeoutMs);
    },
  };
}
