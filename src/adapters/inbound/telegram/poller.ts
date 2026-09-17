/**
 * Long polling inbound adapter (DESIGN §1, §3, §4, §5).
 *
 * "Long polling, not webhooks: no public URL, no TLS termination, and the
 * persisted `offset` is crash recovery for free." The offset lives in
 * `PollStateStore`, written only after a batch is durably processed, never
 * before.
 *
 * Two independently testable layers:
 *
 * - `processUpdate` / `processBotJoin` — pure-ish async functions taking one
 *   already-fetched `Update` plus the driven ports it needs. This is what the
 *   table-driven fixture tests exercise, entirely against fakes.
 * - `TelegramPoller` — the stateful loop around them: owns the offset, the
 *   startup gap detector, and the real `getUpdates` round trip.
 */
import { Api } from 'grammy';
import type { Update } from 'grammy/types';

/** The literal union `Api.raw.getUpdates` expects for `allowed_updates`. */
type AllowedUpdateKind = Exclude<keyof Update, 'update_id'>;

import { UnexpectedError } from '../../../domain/errors.js';
import { asChatId } from '../../../domain/model/ids.js';
import type { ChatId, ThreadId, UserId } from '../../../domain/model/ids.js';
import { Temporal } from '../../../domain/time/temporal.js';
import type { ChatGateway } from '../../../application/ports/driven/chat-gateway.js';
import type { Clock } from '../../../application/ports/driven/clock.js';
import type { Config } from '../../../application/ports/driven/config.js';
import type { ErrorReporter } from '../../../application/ports/driven/error-reporter.js';
import type { MessageStore } from '../../../application/ports/driven/message-store.js';
import type { PollStateStore } from '../../../application/ports/driven/poll-state-store.js';
import type { IngestMessage, IngestOutcome } from '../../../application/ports/driving/ingest-message.js';
import type { IngestMessageCommandExt } from '../../../application/usecases/ingest-message.js';
import {
  extractBotJoin,
  extractIncomingMessage,
  isFromOtherBot,
  mapTelegramMessageToStoredMessage,
} from './map.js';

/* -------------------------------------------------------------------------- */
/* Startup gap detection (DESIGN §4)                                          */
/* -------------------------------------------------------------------------- */

/**
 * "On startup, if `now - last_seen_at` exceeds a threshold, insert a
 * `gap_marker` row. Any range overlapping a gap gets an explicit line in the
 * output."
 *
 * The marker is inserted lazily, into whichever `(chat, thread)` is first
 * touched after startup — the store has no "list every known chat" operation
 * (deliberately: WS1's real adapter would have to scan the whole table), so
 * this is the only point that ever learns which chats are live. Each pair
 * gets at most one marker per process lifetime.
 */
export class GapMarkerTracker {
  readonly #pending: boolean;
  readonly #gapEndedAt: Temporal.Instant;
  readonly #marked = new Set<string>();

  constructor(lastSeenAt: Temporal.Instant | null, startedAt: Temporal.Instant, thresholdMinutes: number) {
    this.#gapEndedAt = startedAt;
    this.#pending =
      lastSeenAt !== null &&
      Temporal.Instant.compare(startedAt, lastSeenAt) > 0 &&
      startedAt.since(lastSeenAt).total('minutes') >= thresholdMinutes;
  }

  /** True on the very first startup, or once the threshold was not exceeded. */
  get pending(): boolean {
    return this.#pending;
  }

  async ensureMarker(chatId: ChatId, threadId: ThreadId | null, messages: MessageStore): Promise<void> {
    if (!this.#pending) return;
    const key = `${String(chatId)}:${threadId === null ? 'general' : String(threadId)}`;
    if (this.#marked.has(key)) return;
    this.#marked.add(key);
    await messages.insertGapMarker(chatId, { threadId, ts: this.#gapEndedAt, text: null });
  }
}

/* -------------------------------------------------------------------------- */
/* Message ingestion pipeline                                                 */
/* -------------------------------------------------------------------------- */

export interface ProcessUpdateContext {
  readonly ingest: IngestMessage;
  readonly botUserId: UserId;
  readonly gapTracker: GapMarkerTracker;
  readonly messages: MessageStore;
}

export type PollerEventOutcome =
  | IngestOutcome
  | { readonly kind: 'joined'; readonly chatId: ChatId }
  | { readonly kind: 'join_not_authorised'; readonly chatId: ChatId }
  | { readonly kind: 'ignored'; readonly reason: 'not_a_message' };

/**
 * The full per-update pipeline for `message` / `edited_message` updates:
 * gap-marker check, mapping, then `IngestMessage.execute()`. Everything else
 * (`callback_query`, `poll_answer`, …) is `{ kind: 'ignored' }` — not this
 * workstream's concern.
 */
export async function processUpdate(
  update: Update,
  ctx: ProcessUpdateContext,
): Promise<PollerEventOutcome> {
  const extracted = extractIncomingMessage(update);
  if (extracted === null) return { kind: 'ignored', reason: 'not_a_message' };

  const { message: tgMessage, isEdit } = extracted;
  const chatId = asChatId(tgMessage.chat.id);
  const stored = mapTelegramMessageToStoredMessage(tgMessage, chatId);
  if (stored === null) return { kind: 'skipped', reason: 'no_content' };

  // Before the message is stored, not after: a range that later spans this
  // instant must see the hole regardless of whether this particular message
  // itself survives the ingest checks below (DESIGN §4).
  await ctx.gapTracker.ensureMarker(chatId, stored.threadId, ctx.messages);

  const command: IngestMessageCommandExt = {
    message: stored,
    isEdit,
    botUserId: ctx.botUserId,
    senderIsOtherBot: isFromOtherBot(tgMessage, ctx.botUserId),
  };
  return await ctx.ingest.execute(command);
}

/* -------------------------------------------------------------------------- */
/* Join announcement (DESIGN §5)                                              */
/* -------------------------------------------------------------------------- */

export interface JoinContext {
  readonly botUserId: UserId;
  readonly config: Config;
  readonly gateway: ChatGateway;
}

const JOIN_NOT_AUTHORISED_TEXT: Readonly<Record<'pl' | 'en', string>> = {
  pl: 'Ten czat nie jest autoryzowany do korzystania z tego bota. Opuszczam — nic nie zostało zapisane.',
  en: 'This chat is not authorised to use this bot. Leaving — nothing was stored.',
};

const JOIN_ANNOUNCEMENT_TEXT: Readonly<Record<'pl' | 'en', (contact: string) => string>> = {
  pl: (contact) =>
    'Cześć! Od teraz zapisuję wiadomości z tego czatu, żeby móc je podsumowywać na komendę /tldr. ' +
    `Co i jak długo przechowuję opisuje /privacy. Pytania i prośby o usunięcie danych: ${contact}.`,
  en: (contact) =>
    "Hi! I'll start logging this chat's messages so I can summarise them with /tldr. " +
    `See /privacy for what is stored and for how long. Questions and data-removal requests: ${contact}.`,
};

/**
 * DESIGN §5: "Join announcement + `/privacy` carry the operator contact."
 * Fires on the `my_chat_member` transition where this bot goes from not-in
 * to in-the-chat. Reuses the same allowlist decision as message ingestion —
 * a chat that is not allowlisted gets the refusal immediately on join,
 * before any message could ever be stored.
 */
export async function processBotJoin(update: Update, ctx: JoinContext): Promise<PollerEventOutcome> {
  const joined = extractBotJoin(update, ctx.botUserId);
  if (joined === null) return { kind: 'ignored', reason: 'not_a_message' };

  const allowlist = ctx.config.get('telegram').allowlist;
  if (!allowlist.includes(joined.chatId)) {
    const language = ctx.config.get('bot').language;
    await ctx.gateway.sendText(joined.chatId, {
      text: JOIN_NOT_AUTHORISED_TEXT[language],
      threadId: null,
    });
    await ctx.gateway.leaveChat(joined.chatId);
    return { kind: 'join_not_authorised', chatId: joined.chatId };
  }

  const bot = ctx.config.get('bot');
  if (bot.announceOnJoin) {
    await ctx.gateway.sendText(joined.chatId, {
      text: JOIN_ANNOUNCEMENT_TEXT[bot.language](bot.operatorContact),
      threadId: null,
    });
  }
  return { kind: 'joined', chatId: joined.chatId };
}

/* -------------------------------------------------------------------------- */
/* The real getUpdates transport                                              */
/* -------------------------------------------------------------------------- */

export interface GetUpdatesParams {
  readonly offset: number;
  readonly timeoutSeconds: number;
  readonly allowedUpdates: readonly string[];
}

/**
 * The one grammY dependency `TelegramPoller` actually needs: fetching raw
 * updates. Everything else — sending, editing, leaving — goes through
 * `ChatGateway` (WS5), which already exists as a port. Kept as a narrow
 * interface (rather than depending on `grammy`'s `Api` directly) so a test
 * can supply an in-file fake without touching the network.
 */
export interface TelegramUpdatesSource {
  getUpdates(params: GetUpdatesParams): Promise<readonly Update[]>;
}

/** Production implementation: `grammy`'s raw `Api.getUpdates`. */
export class GrammyUpdatesSource implements TelegramUpdatesSource {
  readonly #api: Api;

  constructor(botToken: string) {
    this.#api = new Api(botToken);
  }

  async getUpdates(params: GetUpdatesParams): Promise<readonly Update[]> {
    return await this.#api.raw.getUpdates({
      offset: params.offset,
      timeout: params.timeoutSeconds,
      allowed_updates: [...params.allowedUpdates],
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The poller                                                                 */
/* -------------------------------------------------------------------------- */

export interface PollerDeps {
  readonly updatesSource: TelegramUpdatesSource;
  readonly ingest: IngestMessage;
  readonly messages: MessageStore;
  readonly pollState: PollStateStore;
  readonly config: Config;
  readonly gateway: ChatGateway;
  readonly clock: Clock;
  readonly reporter: ErrorReporter;
}

/** Backoff between failed poll rounds in `run()`, so an outage does not spin the process. */
const POLL_ERROR_BACKOFF_MS = 5000;

export class TelegramPoller {
  readonly #deps: PollerDeps;
  #botUserId: UserId | null = null;
  #gapTracker: GapMarkerTracker | null = null;
  /** `-1` means "nothing processed yet": `getUpdates` is called with `offset: 0`. */
  #lastUpdateId = -1;

  constructor(deps: PollerDeps) {
    this.#deps = deps;
  }

  /**
   * Resolves the bot's own identity and arms the startup gap detector.
   * Idempotent — `pollOnce()` and `run()` both call it, and it does nothing
   * on the second call onward.
   */
  async start(): Promise<void> {
    if (this.#botUserId !== null) return;

    const identity = await this.#deps.gateway.getMe();
    this.#botUserId = identity.userId;

    const state = await this.#deps.pollState.load();
    this.#lastUpdateId = state?.lastUpdateId ?? -1;

    const gapThresholdMinutes = this.#deps.config.get('retention').gapThresholdMinutes;
    const startedAt = this.#deps.clock.now();
    this.#gapTracker = new GapMarkerTracker(state?.lastSeenAt ?? null, startedAt, gapThresholdMinutes);
  }

  /**
   * One `getUpdates` round trip: fetch, process every update in order,
   * persist the new offset. The offset always advances past every update in
   * the batch, including ones whose processing threw — Telegram will not
   * redeliver an update once a later offset has been requested, and getting
   * permanently stuck reprocessing one bad update would silently drop every
   * update behind it (worse than losing the one).
   */
  async pollOnce(): Promise<readonly PollerEventOutcome[]> {
    await this.start();
    if (this.#botUserId === null || this.#gapTracker === null) {
      // Unreachable: start() always sets both together before returning.
      throw new UnexpectedError();
    }
    const botUserId = this.#botUserId;
    const gapTracker = this.#gapTracker;

    const telegram = this.#deps.config.get('telegram');
    let updates: readonly Update[];
    try {
      updates = await this.#deps.updatesSource.getUpdates({
        offset: this.#lastUpdateId + 1,
        timeoutSeconds: telegram.pollTimeoutSeconds,
        allowedUpdates: telegram.allowedUpdates,
      });
    } catch (error) {
      this.#deps.reporter.capture(error, { phase: 'poll', adapter: 'telegram_in' });
      throw error;
    }

    const outcomes: PollerEventOutcome[] = [];
    for (const update of updates) {
      try {
        const joinOutcome = await processBotJoin(update, {
          botUserId,
          config: this.#deps.config,
          gateway: this.#deps.gateway,
        });
        if (joinOutcome.kind === 'ignored') {
          outcomes.push(
            await processUpdate(update, {
              ingest: this.#deps.ingest,
              botUserId,
              gapTracker,
              messages: this.#deps.messages,
            }),
          );
        } else {
          outcomes.push(joinOutcome);
        }
      } catch (error) {
        this.#deps.reporter.capture(error, { phase: 'ingest', adapter: 'telegram_in' });
      }
      this.#lastUpdateId = update.update_id;
    }

    // Saved every round, even an empty one: `lastSeenAt` means "the poller
    // was alive at this instant", not "a message arrived". Without this, a
    // quiet-but-healthy stretch would look like downtime to the next
    // startup's gap detector.
    await this.#deps.pollState.save({
      lastUpdateId: this.#lastUpdateId,
      lastSeenAt: this.#deps.clock.now(),
    });

    return outcomes;
  }

  /**
   * The production loop. Runs until `signal` aborts (graceful shutdown:
   * finish the in-flight poll, then stop — DESIGN §3, bootstrap's job to call
   * this with an `AbortController`).
   */
  async run(signal?: AbortSignal): Promise<void> {
    await this.start();
    while (signal?.aborted !== true) {
      try {
        await this.pollOnce();
      } catch {
        // Already reported inside pollOnce(); back off so a persistent
        // outage does not spin the process in a tight loop.
        await this.#deps.clock.sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  }
}
