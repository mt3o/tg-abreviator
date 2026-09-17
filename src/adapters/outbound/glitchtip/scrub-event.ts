/**
 * The `beforeSend` hook (DESIGN §11) — the second line of defence behind the
 * `ErrorContext` type itself.
 *
 * Pure and synchronous, so it is testable without a network call or a DSN:
 * WS8's central DoD assertion — "no message text, question text, real display
 * name or raw id survives" — is made by feeding this function events built
 * from every error path in the codebase and inspecting what comes out, not by
 * inspecting what Sentry actually transmits.
 *
 * What it does, in order:
 *
 * 1. Drops the event entirely for anything `shouldReport()` says is a metric,
 *    not an incident (DESIGN §11, "What is worth reporting").
 * 2. Rewrites the exception message and top-level `message` to
 *    `safeMessageOf(hint.originalException)` — **not** whatever the SDK
 *    auto-populated from `error.message`, which may legitimately carry user
 *    content for local logs (DESIGN §6, `errors.ts`).
 * 3. Strips any captured local-variable values from stack frames (belt and
 *    braces: the local-variables integration is opt-in and off by default, but
 *    a frame variable is exactly the shape of leak this file exists to stop).
 * 4. Drops `event.extra` and `event.contexts` wholesale.
 * 5. Drops breadcrumbs wholesale (console and HTTP-body breadcrumbs are also
 *    disabled at the integration level in `glitchtip-reporter.ts`; this is the
 *    fallback if one slips through anyway).
 * 6. Strips everything from `event.request` except the URL shape — no body, no
 *   cookies, no headers.
 * 7. Drops `event.user` — identities travel as `PseudonymLabel` tags, never as
 *    a Sentry `user`.
 * 8. Rebuilds `event.tags` from the allowlist and nothing else.
 */
import type { ErrorEvent, EventHint, StackFrame } from '@sentry/node';
import { safeMessageOf, shouldReport } from '../../../domain/errors.js';
import { ALLOWED_TAG_KEYS } from './tags.js';

function stripFrameVars(frame: StackFrame): StackFrame {
  if (frame.vars === undefined) return frame;
  const { vars: _vars, ...rest } = frame;
  return rest;
}

export function scrubEvent(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (!shouldReport(hint.originalException)) return null;

  const safeMessage = safeMessageOf(hint.originalException);

  event.message = safeMessage;
  if (event.logentry !== undefined) {
    event.logentry = { message: safeMessage };
  }

  if (event.exception?.values !== undefined) {
    event.exception = {
      values: event.exception.values.map((value) => ({
        ...value,
        value: safeMessage,
        stacktrace:
          value.stacktrace === undefined
            ? undefined
            : {
                ...value.stacktrace,
                frames: value.stacktrace.frames?.map(stripFrameVars),
              },
      })),
    };
  }

  delete event.extra;
  delete event.contexts;
  event.breadcrumbs = [];
  delete event.user;

  if (event.request !== undefined) {
    const { url, method, query_string: queryString } = event.request;
    event.request = { url, method, query_string: queryString };
  }

  const rawTags = event.tags ?? {};
  const tags: NonNullable<ErrorEvent['tags']> = {};
  for (const key of ALLOWED_TAG_KEYS) {
    const value = rawTags[key];
    if (value !== undefined) tags[key] = value;
  }
  event.tags = tags;

  return event;
}
