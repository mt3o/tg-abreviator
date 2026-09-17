/**
 * Typed error taxonomy (DESIGN §6, §11).
 *
 * Three properties matter and are therefore on the base class rather than in a
 * lookup table somewhere:
 *
 * - `code` — a closed union. Every branch of the code that has to react to a
 *   failure switches on this, never on a message string.
 * - `safeMessage` — a description that is *guaranteed* to contain no message
 *   text, question text, display name or raw identifier. This, and only this, is
 *   what may be handed to the error sink (DESIGN §11). `Error.message` may
 *   legitimately carry user content for local logs; `safeMessage` may not.
 * - `report` — whether this class of failure belongs in GlitchTip at all
 *   (DESIGN §11, "What is worth reporting"). A 429 with `retry_after`, a 403 on
 *   a DM attempt and a bad range token are expected and handled: they are
 *   metrics, not incidents.
 *
 * Errors whose *own message* may contain user content — a provider 400 echoing
 * the prompt, a SQLite error quoting a row — must be wrapped in `RedactedError`
 * before they travel anywhere external.
 */

export type ErrorCode =
  // range grammar (DESIGN §2)
  | 'range.unparseable'
  | 'range.missing_unit'
  | 'range.out_of_bounds'
  | 'range.anchor_not_found'
  // permissions and allowlist (DESIGN §2, §5)
  | 'permission.denied'
  | 'permission.not_allowlisted'
  // guards (DESIGN §9)
  | 'guard.cooldown'
  | 'guard.concurrent_request'
  | 'guard.daily_cap'
  | 'guard.budget_exhausted'
  // corpus assembly (DESIGN §7)
  | 'corpus.empty'
  | 'corpus.too_large'
  // policy (DESIGN §6, "Product line")
  | 'policy.refused'
  // llm (DESIGN §7)
  | 'llm.provider_error'
  | 'llm.rate_limited'
  | 'llm.invalid_response'
  | 'llm.unknown_model'
  // telegram (DESIGN §1, §8)
  | 'telegram.rate_limited'
  | 'telegram.dm_forbidden'
  | 'telegram.api_error'
  // persistence (DESIGN §3)
  | 'store.failure'
  | 'store.lock_held'
  // configuration (DESIGN §10)
  | 'config.invalid'
  | 'config.missing_env'
  // catch-all
  | 'internal.invalid_value'
  | 'internal.redacted'
  | 'internal.unexpected';

export interface AppErrorOptions {
  readonly cause?: unknown;
}

/** Base class for every error this codebase raises deliberately. */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  /** Safe for external sinks: never contains user content. */
  abstract readonly safeMessage: string;
  /** DESIGN §11: does this belong in the error sink? */
  abstract readonly report: boolean;

  protected constructor(message: string, options?: AppErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
  }
}

/* -------------------------------------------------------------------------- */
/* Range grammar                                                              */
/* -------------------------------------------------------------------------- */

/** Leading token could not be parsed as a range. Answer with `help`, never a guess. */
export class UnparseableRangeError extends AppError {
  override readonly code = 'range.unparseable' as const;
  override readonly report = false;
  override readonly safeMessage = 'range token could not be parsed';
  constructor(
    readonly token: string,
    options?: AppErrorOptions,
  ) {
    super(`unparseable range token: ${token}`, options);
  }
}

/** `50` without a unit (DESIGN §2: a bare positive number is an error with a hint). */
export class MissingRangeUnitError extends AppError {
  override readonly code = 'range.missing_unit' as const;
  override readonly report = false;
  override readonly safeMessage = 'range token is a bare positive number';
  constructor(
    readonly token: string,
    options?: AppErrorOptions,
  ) {
    super(`range token needs a unit: ${token}`, options);
  }
}

/** Parsed, but outside the permitted bounds (e.g. a count over the hard cap). */
export class RangeOutOfBoundsError extends AppError {
  override readonly code = 'range.out_of_bounds' as const;
  override readonly report = false;
  override readonly safeMessage = 'range is outside the permitted bounds';
  constructor(
    readonly limitName: string,
    readonly limit: number,
    options?: AppErrorOptions,
  ) {
    super(`range exceeds ${limitName} (${String(limit)})`, options);
  }
}

/** The replied-to message is not in the store (never seen, or already expired). */
export class AnchorNotFoundError extends AppError {
  override readonly code = 'range.anchor_not_found' as const;
  override readonly report = false;
  override readonly safeMessage = 'reply anchor is not in the store';
  constructor(options?: AppErrorOptions) {
    super('reply anchor is not in the store', options);
  }
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

export class PermissionDeniedError extends AppError {
  override readonly code = 'permission.denied' as const;
  override readonly report = false;
  override readonly safeMessage = 'caller does not hold the required tier';
  constructor(
    readonly requiredTier: string,
    readonly actualTier: string,
    options?: AppErrorOptions,
  ) {
    super(`requires ${requiredTier}, caller is ${actualTier}`, options);
  }
}

/** DESIGN §5: anywhere not on the allowlist — reply, leave, store nothing. */
export class ChatNotAllowlistedError extends AppError {
  override readonly code = 'permission.not_allowlisted' as const;
  override readonly report = false;
  override readonly safeMessage = 'chat is not on the allowlist';
  constructor(options?: AppErrorOptions) {
    super('chat is not on the allowlist', options);
  }
}

/* -------------------------------------------------------------------------- */
/* Guards (DESIGN §9)                                                         */
/* -------------------------------------------------------------------------- */

export class CooldownError extends AppError {
  override readonly code = 'guard.cooldown' as const;
  override readonly report = false;
  override readonly safeMessage = 'per-user cooldown is active';
  constructor(
    readonly retryAfterSeconds: number,
    options?: AppErrorOptions,
  ) {
    super(`cooldown active, ${String(retryAfterSeconds)}s remaining`, options);
  }
}

export class ConcurrentRequestError extends AppError {
  override readonly code = 'guard.concurrent_request' as const;
  override readonly report = false;
  override readonly safeMessage = 'a request is already in flight for this chat';
  constructor(options?: AppErrorOptions) {
    super('a request is already in flight for this chat', options);
  }
}

export class DailyCapError extends AppError {
  override readonly code = 'guard.daily_cap' as const;
  override readonly report = false;
  override readonly safeMessage = 'per-chat daily call cap reached';
  constructor(
    readonly limit: number,
    options?: AppErrorOptions,
  ) {
    super(`daily call cap reached (${String(limit)})`, options);
  }
}

/** The only control that bounds actual liability — a hard stop (DESIGN §9). */
export class BudgetExhaustedError extends AppError {
  override readonly code = 'guard.budget_exhausted' as const;
  /** Reported: the operator wants to know the day the bot stops answering. */
  override readonly report = true;
  override readonly safeMessage = 'global daily USD budget exhausted';
  constructor(
    readonly budgetUsd: number,
    options?: AppErrorOptions,
  ) {
    super(`global daily budget of $${String(budgetUsd)} exhausted`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Corpus                                                                     */
/* -------------------------------------------------------------------------- */

export class EmptyCorpusError extends AppError {
  override readonly code = 'corpus.empty' as const;
  override readonly report = false;
  override readonly safeMessage = 'no stored messages in the resolved range';
  constructor(options?: AppErrorOptions) {
    super('no stored messages in the resolved range', options);
  }
}

/** DESIGN §7: never silently truncate. Over the ceiling, warn and compact. */
export class CorpusTooLargeError extends AppError {
  override readonly code = 'corpus.too_large' as const;
  override readonly report = false;
  override readonly safeMessage = 'corpus exceeds the configured input token ceiling';
  constructor(
    readonly inputTokens: number,
    readonly maxInputTokens: number,
    options?: AppErrorOptions,
  ) {
    super(
      `corpus is ${String(inputTokens)} tokens, ceiling is ${String(maxInputTokens)}`,
      options,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/** DESIGN §6 "Product line": open-ended profiling of a person is refused. */
export type RefusalReason = 'open_ended_profiling' | 'out_of_scope';

export class PolicyRefusalError extends AppError {
  override readonly code = 'policy.refused' as const;
  override readonly report = false;
  override readonly safeMessage = 'request refused by policy';
  constructor(
    readonly reason: RefusalReason,
    options?: AppErrorOptions,
  ) {
    super(`refused: ${reason}`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* LLM                                                                        */
/* -------------------------------------------------------------------------- */

export class LlmProviderError extends AppError {
  override readonly code = 'llm.provider_error' as const;
  /** DESIGN §11: report provider errors *after* retries are exhausted. */
  override readonly report = true;
  override readonly safeMessage = 'llm provider returned an error';
  constructor(
    readonly httpStatus: number | null,
    readonly attempts: number,
    options?: AppErrorOptions,
  ) {
    super(
      `llm provider error (status ${String(httpStatus ?? 'none')}, ${String(attempts)} attempts)`,
      options,
    );
  }
}

export class LlmRateLimitedError extends AppError {
  override readonly code = 'llm.rate_limited' as const;
  override readonly report = false;
  override readonly safeMessage = 'llm provider rate limited the request';
  constructor(
    readonly retryAfterSeconds: number | null,
    options?: AppErrorOptions,
  ) {
    super('llm provider rate limited the request', options);
  }
}

/** Structured output did not match the declared contract. */
export class LlmInvalidResponseError extends AppError {
  override readonly code = 'llm.invalid_response' as const;
  override readonly report = true;
  override readonly safeMessage = 'llm response failed structured-output validation';
  constructor(
    readonly outputName: string,
    options?: AppErrorOptions,
  ) {
    super(`llm response failed validation for output "${outputName}"`, options);
  }
}

/** A routing rule or a chat setting named a model the registry does not define. */
export class UnknownModelError extends AppError {
  override readonly code = 'llm.unknown_model' as const;
  override readonly report = true;
  override readonly safeMessage = 'model alias is not present in the registry';
  constructor(
    readonly alias: string,
    options?: AppErrorOptions,
  ) {
    super(`unknown model alias: ${alias}`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Telegram                                                                   */
/* -------------------------------------------------------------------------- */

/** DESIGN §8: `retry_after` is authoritative — sleep exactly that long. */
export class TelegramRateLimitedError extends AppError {
  override readonly code = 'telegram.rate_limited' as const;
  override readonly report = false;
  override readonly safeMessage = 'telegram rate limited the request';
  constructor(
    readonly retryAfterSeconds: number,
    options?: AppErrorOptions,
  ) {
    super(`telegram rate limited, retry after ${String(retryAfterSeconds)}s`, options);
  }
}

/** DESIGN §1: a bot cannot initiate a DM with a user who never `/start`ed it. */
export class DmForbiddenError extends AppError {
  override readonly code = 'telegram.dm_forbidden' as const;
  override readonly report = false;
  override readonly safeMessage = 'user has not started a private chat with the bot';
  constructor(options?: AppErrorOptions) {
    super('user has not started a private chat with the bot', options);
  }
}

export class TelegramApiError extends AppError {
  override readonly code = 'telegram.api_error' as const;
  override readonly report = true;
  override readonly safeMessage = 'telegram api returned an unexpected error';
  constructor(
    readonly httpStatus: number | null,
    readonly method: string,
    options?: AppErrorOptions,
  ) {
    super(`telegram ${method} failed with status ${String(httpStatus ?? 'none')}`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A store operation failed. The underlying driver error frequently quotes row
 * contents, so it goes in `cause` for local logs only — never into `safeMessage`.
 */
export class StoreError extends AppError {
  override readonly code = 'store.failure' as const;
  override readonly report = true;
  override readonly safeMessage = 'store operation failed';
  constructor(
    readonly operation: string,
    options?: AppErrorOptions,
  ) {
    super(`store operation failed: ${operation}`, options);
  }
}

/** DESIGN §3: exactly one instance. A second process must exit loudly. */
export class LockHeldError extends AppError {
  override readonly code = 'store.lock_held' as const;
  override readonly report = true;
  override readonly safeMessage = 'another instance holds the lockfile';
  constructor(
    readonly lockPath: string,
    options?: AppErrorOptions,
  ) {
    super(`another instance holds the lockfile at ${lockPath}`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface ConfigIssue {
  /** Dotted path into the resolved config, e.g. `models.routing.0.use`. */
  readonly path: string;
  readonly message: string;
}

/** DESIGN §10: fail fast with a readable message. */
export class ConfigValidationError extends AppError {
  override readonly code = 'config.invalid' as const;
  override readonly report = true;
  override readonly safeMessage = 'configuration failed validation';
  constructor(
    readonly issues: readonly ConfigIssue[],
    options?: AppErrorOptions,
  ) {
    super(
      `configuration failed validation:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
      options,
    );
  }
}

export class MissingEnvError extends AppError {
  override readonly code = 'config.missing_env' as const;
  override readonly report = true;
  override readonly safeMessage = 'a required environment variable is not set';
  constructor(
    readonly variable: string,
    options?: AppErrorOptions,
  ) {
    super(`environment variable ${variable} is not set`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Catch-all                                                                  */
/* -------------------------------------------------------------------------- */

/** A value failed a domain invariant (a malformed identifier, a bad enum). */
export class InvalidValueError extends AppError {
  override readonly code = 'internal.invalid_value' as const;
  override readonly report = false;
  override readonly safeMessage = 'value failed a domain invariant';
  constructor(
    readonly what: string,
    options?: AppErrorOptions,
  ) {
    super(`invalid value: ${what}`, options);
  }
}

/**
 * DESIGN §11: the dangerous case is an error that carries user content *in its
 * own message* — a provider 400 echoing the prompt, a SQLite error quoting a
 * row. Wrap it: the sink gets a redacted type plus a correlation id, and the
 * full text stays in local logs.
 *
 * The correlation id is supplied by the caller (from `IdGenerator`) because the
 * domain owns no randomness.
 */
export class RedactedError extends AppError {
  override readonly code = 'internal.redacted' as const;
  override readonly report = true;
  override readonly safeMessage: string;
  constructor(
    readonly originalType: string,
    readonly correlationId: string,
    options?: AppErrorOptions,
  ) {
    super(`${originalType} [correlation ${correlationId}]`, options);
    this.safeMessage = `redacted ${originalType} [correlation ${correlationId}]`;
  }
}

/** Anything that reached a boundary without being classified. */
export class UnexpectedError extends AppError {
  override readonly code = 'internal.unexpected' as const;
  override readonly report = true;
  override readonly safeMessage = 'unexpected error';
  constructor(options?: AppErrorOptions) {
    super('unexpected error', options);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function errorCodeOf(value: unknown): ErrorCode {
  return isAppError(value) ? value.code : 'internal.unexpected';
}

/** DESIGN §11 report/don't-report split, with unknown failures reported. */
export function shouldReport(value: unknown): boolean {
  return isAppError(value) ? value.report : true;
}

/**
 * The only error description that may be handed to an external sink. Unknown
 * errors collapse to their constructor name — never their message, which may
 * quote a row or a prompt.
 */
export function safeMessageOf(value: unknown): string {
  if (isAppError(value)) return value.safeMessage;
  if (value instanceof Error) return `unhandled ${value.name}`;
  return 'unhandled non-error throwable';
}
