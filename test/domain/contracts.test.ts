/**
 * The domain contracts the other twelve workstreams build on.
 *
 * These are not "tests for types" — each one pins a decision that a later
 * workstream could otherwise reinterpret: what ordering a corpus has, which
 * errors are allowed to reach the error sink, and what a pseudonym is.
 */
import { describe, expect, it } from 'vitest';

import {
  AnchorNotFoundError,
  BudgetExhaustedError,
  CooldownError,
  DmForbiddenError,
  InvalidValueError,
  LlmProviderError,
  MissingRangeUnitError,
  RedactedError,
  StoreError,
  TelegramRateLimitedError,
  UnparseableRangeError,
  errorCodeOf,
  isAppError,
  safeMessageOf,
  shouldReport,
} from '../../src/domain/errors.js';
import {
  asChatId,
  asMessageId,
  asOptionalThreadId,
  asUserId,
  isSyntheticMessageId,
  parseChatId,
  parseUserId,
} from '../../src/domain/model/ids.js';
import { compareMessages, isMessageKind } from '../../src/domain/model/message.js';
import { MAX_RANGE_MESSAGES_HARD_CAP, rawRangeToken } from '../../src/domain/model/range.js';
import { scopeMatches, threadScope } from '../../src/domain/model/scope.js';
import { TIER_RANK } from '../../src/domain/model/tier.js';
import {
  CHAT_PSEUDONYM_USER_ID,
  PSEUDONYM_LABEL_SPACE,
  asPseudonymLabel,
  composeLabel,
} from '../../src/domain/model/pseudonym.js';
import { TOPIC_DEPLOYS, at, makeMessage } from '../conformance/support.js';

describe('identifiers', () => {
  it('accepts the shapes Telegram actually issues', () => {
    expect(asChatId(-1000000000001)).toBe(-1000000000001);
    expect(asUserId(42)).toBe(42);
    expect(asOptionalThreadId(undefined)).toBeNull();
    expect(asOptionalThreadId(null)).toBeNull();
    expect(asOptionalThreadId(7)).toBe(7);
  });

  it('rejects the shapes it does not', () => {
    expect(() => asChatId(0)).toThrow(InvalidValueError);
    expect(() => asChatId(1.5)).toThrow(InvalidValueError);
    expect(() => asUserId(-1)).toThrow(InvalidValueError);
    expect(() => parseChatId('not-a-number')).toThrow(InvalidValueError);
    expect(() => parseUserId('0')).toThrow(InvalidValueError);
  });

  it('reserves non-positive message ids for synthetic rows', () => {
    expect(isSyntheticMessageId(asMessageId(-1))).toBe(true);
    expect(isSyntheticMessageId(asMessageId(1))).toBe(false);
  });
});

describe('corpus ordering', () => {
  it('sorts by timestamp first, then by message id', () => {
    const older = makeMessage({ messageId: 9, ts: at(1) });
    const newer = makeMessage({ messageId: 2, ts: at(2) });
    expect(compareMessages(older, newer)).toBeLessThan(0);
  });

  it('puts a synthetic gap marker at its real point in time', () => {
    const before = makeMessage({ messageId: 1, ts: at(1) });
    const marker = makeMessage({ messageId: -1, ts: at(2), kind: 'gap_marker' });
    const after = makeMessage({ messageId: 2, ts: at(3) });
    const sorted = [after, marker, before].sort(compareMessages);
    expect(sorted.map((m) => m.messageId)).toEqual([1, -1, 2]);
  });

  it('knows its own kinds', () => {
    expect(isMessageKind('gap_marker')).toBe(true);
    expect(isMessageKind('telepathy')).toBe(false);
  });
});

describe('scope', () => {
  it('treats General and a forum topic as different scopes', () => {
    expect(scopeMatches(threadScope(null), null)).toBe(true);
    expect(scopeMatches(threadScope(null), TOPIC_DEPLOYS)).toBe(false);
    expect(scopeMatches(threadScope(TOPIC_DEPLOYS), TOPIC_DEPLOYS)).toBe(true);
  });

  it('lets `all` cross every topic', () => {
    expect(scopeMatches({ kind: 'all' }, TOPIC_DEPLOYS)).toBe(true);
    expect(scopeMatches({ kind: 'all' }, null)).toBe(true);
  });
});

describe('range spec', () => {
  it('keys the dedupe on the raw token, not the resolved window (DESIGN §9)', () => {
    expect(rawRangeToken({ kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } })).toBe(
      '2h',
    );
    expect(rawRangeToken({ kind: 'default', raw: '' })).toBe('');
  });

  it('caps a message count at 500', () => {
    expect(MAX_RANGE_MESSAGES_HARD_CAP).toBe(500);
  });
});

describe('permission tiers', () => {
  it('orders member < chatAdmin < operator', () => {
    expect(TIER_RANK.member).toBeLessThan(TIER_RANK.chatAdmin);
    expect(TIER_RANK.chatAdmin).toBeLessThan(TIER_RANK.operator);
  });
});

describe('pseudonyms', () => {
  it('is two words from the shared list', () => {
    expect(composeLabel(11, 0)).toMatch(/^[a-z]+-[a-z]+$/);
    expect(composeLabel(0, 0)).toBe(composeLabel(0, 0));
    expect(PSEUDONYM_LABEL_SPACE).toBeGreaterThan(1000);
  });

  it('refuses anything that is not a label, which is what keeps raw ids out', () => {
    expect(() => asPseudonymLabel('12345')).toThrow(InvalidValueError);
    expect(() => asPseudonymLabel('Ola Kowalska')).toThrow(InvalidValueError);
  });

  it('reserves user id 0 for the chat itself', () => {
    expect(CHAT_PSEUDONYM_USER_ID).toBe(0);
  });
});

describe('error taxonomy (DESIGN §11, what is worth reporting)', () => {
  it('does not report what is expected and handled', () => {
    expect(shouldReport(new TelegramRateLimitedError(30))).toBe(false);
    expect(shouldReport(new DmForbiddenError())).toBe(false);
    expect(shouldReport(new UnparseableRangeError('wczorajj'))).toBe(false);
    expect(shouldReport(new MissingRangeUnitError('50'))).toBe(false);
    expect(shouldReport(new CooldownError(12))).toBe(false);
    expect(shouldReport(new AnchorNotFoundError())).toBe(false);
  });

  it('reports what an operator has to know about', () => {
    expect(shouldReport(new LlmProviderError(500, 3))).toBe(true);
    expect(shouldReport(new StoreError('upsert'))).toBe(true);
    expect(shouldReport(new BudgetExhaustedError(5))).toBe(true);
  });

  it('reports anything unclassified, because silence is the worse failure', () => {
    expect(shouldReport(new Error('who knows'))).toBe(true);
    expect(errorCodeOf(new Error('who knows'))).toBe('internal.unexpected');
  });

  it('never lets an unknown error message leave the process', () => {
    const leaky = new Error('SQLITE_CONSTRAINT: near "Ola powiedziala ze rzuca prace"');
    expect(safeMessageOf(leaky)).toBe('unhandled Error');
    expect(safeMessageOf(leaky)).not.toContain('Ola');
  });

  it('keeps a redacted error joinable to local logs without carrying the text', () => {
    const original = new Error('provider 400: <transcript>secret things</transcript>');
    const wrapped = new RedactedError('provider_bad_request', 'corr-123', { cause: original });

    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.safeMessage).toContain('corr-123');
    expect(wrapped.safeMessage).not.toContain('secret things');
    expect(wrapped.cause).toBe(original);
  });

  it('carries a typed code rather than a message to switch on', () => {
    expect(errorCodeOf(new CooldownError(5))).toBe('guard.cooldown');
    expect(new CooldownError(5).retryAfterSeconds).toBe(5);
  });
});
