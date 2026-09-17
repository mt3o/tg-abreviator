/**
 * Shared fixtures for the port-conformance suite.
 *
 * Exported because WS1 runs the same suite against SQLite: anything a test needs
 * to build has to be buildable from outside this directory.
 */
import { Temporal } from '../../src/domain/time/temporal.js';
import {
  asChatId,
  asMessageId,
  asThreadId,
  asUsageEventId,
  asUserId,
} from '../../src/domain/model/ids.js';
import type { ChatId, MessageId, ThreadId, UserId } from '../../src/domain/model/ids.js';
import type { MessageKind, StoredMessage } from '../../src/domain/model/message.js';
import type { Chunk } from '../../src/domain/model/chunk.js';
import type { ResolvedRange, RangeStart } from '../../src/domain/model/range.js';
import type { Scope } from '../../src/domain/model/scope.js';
import type { UnitPrices, UsageEvent, UsagePhase, UserRef } from '../../src/domain/model/usage.js';

/** Two chats, because "never cross chats" is the rule most of these tests exist for. */
export const CHAT_A: ChatId = asChatId(-1000000000001);
export const CHAT_B: ChatId = asChatId(-1000000000002);

export const USER_ALA: UserId = asUserId(11);
export const USER_OLA: UserId = asUserId(22);
export const USER_MAREK: UserId = asUserId(33);

export const TOPIC_DEPLOYS: ThreadId = asThreadId(7);
export const TOPIC_RANDOM: ThreadId = asThreadId(9);

export const T0 = Temporal.Instant.from('2026-09-17T09:00:00Z');
export const FAR_PAST = Temporal.Instant.from('1990-01-01T00:00:00Z');
export const FAR_FUTURE = Temporal.Instant.from('2999-01-01T00:00:00Z');

/** `T0 + minutes`, so a test can lay out a conversation by hand. */
export function at(minutes: number): Temporal.Instant {
  return T0.add({ minutes });
}

export interface MessageOverrides {
  readonly chatId?: ChatId;
  readonly messageId?: number;
  readonly threadId?: ThreadId | null;
  readonly userId?: UserId | null;
  readonly displayName?: string | null;
  readonly ts?: Temporal.Instant;
  readonly replyToMessageId?: MessageId | null;
  readonly kind?: MessageKind;
  readonly text?: string | null;
}

export function makeMessage(overrides: MessageOverrides = {}): StoredMessage {
  const messageId = asMessageId(overrides.messageId ?? 1);
  return {
    chatId: overrides.chatId ?? CHAT_A,
    messageId,
    threadId: overrides.threadId === undefined ? null : overrides.threadId,
    userId: overrides.userId === undefined ? USER_ALA : overrides.userId,
    displayName: overrides.displayName === undefined ? 'Ala' : overrides.displayName,
    ts: overrides.ts ?? at(messageId),
    replyToMessageId: overrides.replyToMessageId ?? null,
    kind: overrides.kind ?? 'text',
    text: overrides.text === undefined ? `message ${String(messageId)}` : overrides.text,
  };
}

/** A conversation: ids 1..n one minute apart, all from the same user and thread. */
export function makeConversation(
  count: number,
  overrides: MessageOverrides = {},
): StoredMessage[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage({ ...overrides, messageId: (overrides.messageId ?? 1) + index }),
  );
}

export const THREAD_SCOPE: Scope = { kind: 'thread', threadId: null };
export const ALL_SCOPE: Scope = { kind: 'all' };

export function makeRange(start: RangeStart, overrides: Partial<ResolvedRange> = {}): ResolvedRange {
  return {
    scope: overrides.scope ?? ALL_SCOPE,
    start,
    end: overrides.end ?? FAR_FUTURE,
    limit: overrides.limit ?? 500,
    spec: overrides.spec ?? { kind: 'default', raw: '' },
    basis: overrides.basis ?? 'default',
    clampedToHorizon: overrides.clampedToHorizon ?? false,
    timeZone: overrides.timeZone ?? 'Europe/Warsaw',
  };
}

export function sinceInstant(
  ts: Temporal.Instant,
  overrides: Partial<ResolvedRange> = {},
): ResolvedRange {
  return makeRange({ kind: 'instant', ts }, overrides);
}

export function sinceMessage(
  messageId: MessageId,
  inclusive: boolean,
  overrides: Partial<ResolvedRange> = {},
): ResolvedRange {
  return makeRange({ kind: 'message', messageId, inclusive }, overrides);
}

export function lastN(count: number, overrides: Partial<ResolvedRange> = {}): ResolvedRange {
  return makeRange({ kind: 'lastN', count }, overrides);
}

export const TEST_PRICES: UnitPrices = {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
  cacheReadPerMTokUsd: 0.3,
};

export interface UsageOverrides {
  readonly id?: string;
  readonly chatId?: ChatId;
  readonly threadId?: ThreadId | null;
  readonly user?: UserRef;
  readonly ts?: Temporal.Instant;
  readonly model?: string;
  readonly phase?: UsagePhase;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros?: number;
  readonly rangeSpec?: string;
  readonly questionHash?: string | null;
}

export function makeUsageEvent(overrides: UsageOverrides = {}): UsageEvent {
  return {
    id: asUsageEventId(overrides.id ?? 'usage-1'),
    ts: overrides.ts ?? at(0),
    chatId: overrides.chatId ?? CHAT_A,
    threadId: overrides.threadId === undefined ? null : overrides.threadId,
    user: overrides.user ?? { kind: 'user', userId: USER_ALA },
    model: overrides.model ?? 'claude-sonnet-5',
    phase: overrides.phase ?? 'single',
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 200,
    costMicros: overrides.costMicros ?? 6000,
    unitPrices: TEST_PRICES,
    rangeSpec: overrides.rangeSpec ?? '-50',
    questionHash: overrides.questionHash === undefined ? null : overrides.questionHash,
    status: 'ok',
  };
}

export interface ChunkOverrides {
  readonly chatId?: ChatId;
  readonly threadId?: ThreadId | null;
  readonly firstMsgId?: number;
  readonly lastMsgId?: number;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly text?: string;
  readonly createdAt?: Temporal.Instant;
}

export function makeChunk(overrides: ChunkOverrides = {}): Chunk {
  return {
    chatId: overrides.chatId ?? CHAT_A,
    threadId: overrides.threadId === undefined ? null : overrides.threadId,
    firstMsgId: asMessageId(overrides.firstMsgId ?? 1),
    lastMsgId: asMessageId(overrides.lastMsgId ?? 10),
    model: overrides.model ?? 'claude-haiku-4-5',
    promptVersion: overrides.promptVersion ?? 'v1',
    text: overrides.text ?? 'a compacted summary',
    createdAt: overrides.createdAt ?? at(30),
  };
}

/**
 * How an implementation hands itself to the suite.
 *
 * Called once per test, so every test starts from an empty store: a shared
 * store between tests would hide exactly the leaks these tests look for.
 */
export interface ConformanceFixture<T> {
  readonly store: T;
  teardown?(): Promise<void> | void;
}

export type ConformanceFactory<T> = () =>
  | ConformanceFixture<T>
  | Promise<ConformanceFixture<T>>;
