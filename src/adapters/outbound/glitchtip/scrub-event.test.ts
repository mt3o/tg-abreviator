/**
 * WS8's central DoD assertion (DESIGN §11): build events from every error path
 * in the codebase, run them through `scrubEvent` (the `beforeSend` hook), and
 * assert that no message text, question text, real display name or raw id
 * survives — only allowlisted tags and pseudonyms.
 *
 * The events built here simulate the *worst case*, not the happy path: they
 * are shaped as if the SDK's default machinery (message-from-`error.message`,
 * `linkedErrorsIntegration` walking `.cause`, a stray `extra`/`contexts`/tag
 * some other code path attached) had already run, unscrubbed. `scrubEvent` is
 * the only thing standing between that and GlitchTip, so it has to win against
 * every one of these, not just against tidy input.
 */
import { describe, expect, it } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/node';
import {
  AnchorNotFoundError,
  BudgetExhaustedError,
  ChatNotAllowlistedError,
  ConcurrentRequestError,
  ConfigValidationError,
  CooldownError,
  CorpusTooLargeError,
  DailyCapError,
  DmForbiddenError,
  EmptyCorpusError,
  InvalidValueError,
  LlmInvalidResponseError,
  LlmProviderError,
  LlmRateLimitedError,
  LockHeldError,
  MissingEnvError,
  MissingRangeUnitError,
  PermissionDeniedError,
  PolicyRefusalError,
  RangeOutOfBoundsError,
  RedactedError,
  StoreError,
  TelegramApiError,
  TelegramRateLimitedError,
  UnexpectedError,
  UnknownModelError,
  UnparseableRangeError,
  safeMessageOf,
  shouldReport,
} from '../../../domain/errors.js';
import { asPseudonymLabel } from '../../../domain/model/pseudonym.js';
import { scrubEvent } from './scrub-event.js';

/** A marker distinctive enough that any accidental substring match is a real bug. */
const LEAK = 'LEAK-Ola Kowalska said: sorry wrong chat, meeting is at 19:00 at Ewa’s-9f3a1c';

/**
 * Builds an unscrubbed event exactly the way the real SDK pipeline would leave
 * it before `beforeSend` runs: message and exception value pulled straight
 * from `error.message` (which may legitimately carry user content — see
 * `errors.ts`), a second linked-cause exception entry (as `linkedErrorsIntegration`
 * would add), a captured local variable on a stack frame, a stray unexpected
 * tag, and `extra`/`contexts`/`breadcrumbs`/`request`/`user` all populated with
 * the kind of thing a careless call site could attach.
 */
function hostileEvent(error: unknown): ErrorEvent {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    type: undefined,
    message: rawMessage,
    exception: {
      values: [
        {
          type: error instanceof Error ? error.name : 'NonError',
          value: rawMessage,
          stacktrace: {
            frames: [
              {
                function: 'handleRange',
                filename: 'src/adapters/inbound/telegram/dispatch.ts',
                lineno: 42,
                vars: { text: LEAK, displayName: 'Ola Kowalska' },
              },
            ],
          },
        },
        // Simulates linkedErrorsIntegration walking `.cause` into a second entry.
        { type: 'SqliteError', value: `duplicate row: ${LEAK}` },
      ],
    },
    tags: {
      phase: 'dispatch',
      user: asPseudonymLabel('kind-otter'),
      leakyField: LEAK,
    },
    extra: { transcript: LEAK },
    contexts: { app: { name: LEAK } },
    breadcrumbs: [
      { category: 'console', message: LEAK, timestamp: 0 },
      { category: 'http', data: { body: LEAK }, timestamp: 0 },
    ],
    request: {
      url: 'https://api.telegram.org/botTOKEN/sendMessage',
      method: 'POST',
      data: { text: LEAK },
      cookies: { session: LEAK },
      headers: { authorization: LEAK },
    },
    user: { id: '555', username: 'Ola Kowalska' },
  };
}

function hint(error: unknown): EventHint {
  return { originalException: error };
}

interface Case {
  readonly name: string;
  readonly build: () => unknown;
}

/** One case per `AppError` subclass in `errors.ts`, plus the non-AppError paths. */
const cases: readonly Case[] = [
  { name: 'UnparseableRangeError', build: () => new UnparseableRangeError(LEAK) },
  { name: 'MissingRangeUnitError', build: () => new MissingRangeUnitError(LEAK) },
  { name: 'RangeOutOfBoundsError', build: () => new RangeOutOfBoundsError('maxRangeDays', 30) },
  { name: 'AnchorNotFoundError', build: () => new AnchorNotFoundError() },
  {
    name: 'PermissionDeniedError',
    build: () => new PermissionDeniedError('operator', 'member'),
  },
  { name: 'ChatNotAllowlistedError', build: () => new ChatNotAllowlistedError() },
  { name: 'CooldownError', build: () => new CooldownError(12) },
  { name: 'ConcurrentRequestError', build: () => new ConcurrentRequestError() },
  { name: 'DailyCapError', build: () => new DailyCapError(50) },
  { name: 'BudgetExhaustedError', build: () => new BudgetExhaustedError(5) },
  { name: 'EmptyCorpusError', build: () => new EmptyCorpusError() },
  {
    name: 'CorpusTooLargeError',
    build: () => new CorpusTooLargeError(500_000, 200_000),
  },
  { name: 'PolicyRefusalError', build: () => new PolicyRefusalError('open_ended_profiling') },
  { name: 'LlmProviderError', build: () => new LlmProviderError(500, 3) },
  { name: 'LlmRateLimitedError', build: () => new LlmRateLimitedError(30) },
  { name: 'LlmInvalidResponseError', build: () => new LlmInvalidResponseError('summary') },
  { name: 'UnknownModelError', build: () => new UnknownModelError('claude-ghost') },
  { name: 'TelegramRateLimitedError', build: () => new TelegramRateLimitedError(5) },
  { name: 'DmForbiddenError', build: () => new DmForbiddenError() },
  { name: 'TelegramApiError', build: () => new TelegramApiError(500, 'sendMessage') },
  { name: 'StoreError', build: () => new StoreError(`upsert (row: ${LEAK})`) },
  { name: 'LockHeldError', build: () => new LockHeldError('/var/run/tg-abreviator.lock') },
  {
    name: 'ConfigValidationError',
    build: () =>
      new ConfigValidationError([{ path: 'models.routing.0.use', message: 'unknown model' }]),
  },
  { name: 'MissingEnvError', build: () => new MissingEnvError('ANTHROPIC_API_KEY') },
  { name: 'InvalidValueError', build: () => new InvalidValueError(LEAK) },
  {
    name: 'RedactedError',
    build: () => new RedactedError('SqliteError', 'corr-9f3a1c', { cause: new Error(LEAK) }),
  },
  { name: 'UnexpectedError', build: () => new UnexpectedError() },
  { name: 'plain Error (unhandled)', build: () => new Error(LEAK) },
  { name: 'non-Error throwable (string)', build: () => LEAK },
  { name: 'non-Error throwable (object)', build: () => ({ weird: LEAK }) },
];

describe('scrubEvent — every error path', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_label, testCase) => {
    const error = testCase.build();
    const event = hostileEvent(error);
    const result = scrubEvent(event, hint(error));

    if (!shouldReport(error)) {
      // DESIGN §11 "What is worth reporting": dropped entirely, not just scrubbed.
      expect(result).toBeNull();
      return;
    }

    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(LEAK);
    expect(serialized).not.toContain('Ola Kowalska');
    expect(serialized).not.toContain('555');

    const safe = safeMessageOf(error);
    expect(result?.message).toBe(safe);
    for (const value of result?.exception?.values ?? []) {
      expect(value.value).toBe(safe);
      for (const frame of value.stacktrace?.frames ?? []) {
        expect(frame.vars).toBeUndefined();
      }
    }

    expect(result?.extra).toBeUndefined();
    expect(result?.contexts).toBeUndefined();
    expect(result?.breadcrumbs).toEqual([]);
    expect(result?.user).toBeUndefined();
    expect(result?.request?.data).toBeUndefined();
    expect(result?.request?.cookies).toBeUndefined();
    expect(result?.request?.headers).toBeUndefined();

    // Allowlist, not blocklist: the unexpected tag never appears...
    expect(result?.tags?.['leakyField']).toBeUndefined();
    // ...while an allowlisted one survives untouched.
    expect(result?.tags?.['phase']).toBe('dispatch');
    expect(result?.tags?.['user']).toBe('kind-otter');
  });
});

describe('scrubEvent — allowlist, not blocklist', () => {
  it('drops a field nobody thought to block', () => {
    const error = new LlmProviderError(500, 1);
    const event: ErrorEvent = {
      type: undefined,
      tags: {
        phase: 'llm',
        model: 'claude-cheap',
        // Nobody wrote this key into the allowlist on purpose — it must still
        // be dropped, because the allowlist is exhaustive by construction.
        somebodyAddedThisLater: 'the user asked about their diagnosis',
      },
    };

    const result = scrubEvent(event, hint(error));

    expect(result?.tags).toEqual({ phase: 'llm', model: 'claude-cheap' });
    expect(Object.keys(result?.tags ?? {})).not.toContain('somebodyAddedThisLater');
  });
});

describe('scrubEvent — report/do-not-report split', () => {
  it('does not report expected, handled failures (DESIGN §11)', () => {
    for (const error of [
      new TelegramRateLimitedError(30),
      new DmForbiddenError(),
      new UnparseableRangeError('wczorajj'),
      new MissingRangeUnitError('50'),
      new CooldownError(12),
      new AnchorNotFoundError(),
    ]) {
      expect(scrubEvent(hostileEvent(error), hint(error))).toBeNull();
    }
  });

  it('reports unhandled exceptions and provider errors', () => {
    for (const error of [
      new LlmProviderError(500, 3),
      new StoreError('upsert'),
      new BudgetExhaustedError(5),
      new Error('who knows'),
    ]) {
      expect(scrubEvent(hostileEvent(error), hint(error))).not.toBeNull();
    }
  });
});
