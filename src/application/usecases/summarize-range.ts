/**
 * `SummarizeRange` (DESIGN §2, §3, §7, §8) and the shared single-shot pipeline
 * `AnswerQuestion` (`answer-question.ts`) also runs — range and intent are
 * orthogonal (DESIGN §2), and the two driving ports differ only in whether a
 * question travels alongside the range.
 *
 * What this pipeline does, in order:
 *
 * 1. **Scope.** `all` wins outright. Otherwise, when the range is about to
 *    fall back to a reply anchor (DESIGN §2: "since the replied-to message"),
 *    the *anchor's* thread is used for scoping — DESIGN §2: "If the reply
 *    anchor lives in a different topic than the invocation, follow the
 *    anchor's thread; answer in the topic the user is standing in." The reply
 *    itself still goes to the thread the user is standing in
 *    (`invocation.threadId`) — see `deliver` below.
 * 2. **Resolve.** `resolve()` (WS3, pure) turns the parsed spec into a
 *    concrete window, given `now` (`Clock`), the chat's zone, and the corpus
 *    horizon (`MessageStore.oldest`).
 * 3. **Fetch**, with bot and opt-out exclusion applied at query time (DESIGN
 *    §6.3, §6.4) — never in the prompt. DESIGN §2: "`-N` counts stored human
 *    messages only", so non-human kinds are excluded from the query itself
 *    *only* for a `lastN` start — the store's `-N` counting logic depends on
 *    the same options applying to `countInRange`'s "keep the last N" step.
 *    For every other range shape, non-human rows stay in: a gap marker has to
 *    survive the fetch to be surfaced (DESIGN §4).
 *
 *    "Anchor older than the horizon → clamp and say so" (DESIGN §7, §10) is
 *    `fetchRows` below: `AnchorNotFoundError` — the anchor has expired out of
 *    the store — is caught, the range is clamped to `MessageStore.oldest`,
 *    and `clampedToHorizon` is set so the header can disclose it.
 * 4. **Assemble** (`src/domain/corpus/assemble.ts`, pure): formatting,
 *    gap-marker disclosure, media placeholders. `corpus.empty` fires here
 *    when nothing human survived — including the "only a gap marker matched"
 *    case a bare row count would miss.
 * 5. **Token-check before the call** (DESIGN §7): `count_tokens` against
 *    `limits.maxInputTokens`. Under it, single call. Over it, this warns —
 *    the placeholder carries a visible "range is large" notice, never a
 *    silent switch — and hands off to WS11's `Compactor` (`compactAndAnswer`
 *    below): map phase on the cheap model, reduce on the strong one, chunk
 *    cache reused via `ChunkStore`, progress throttled into the same
 *    placeholder. `corpus.too_large` now fires only for the genuinely
 *    unservable case `Compactor` itself detects — an atomic unit (or a
 *    plateaued reduce round) that still will not fit `maxInputTokens` after
 *    compaction — never merely because the raw corpus was over the
 *    threshold (DESIGN §7: "never silently truncate").
 * 6. **Call** the model with a structured-output contract (DESIGN §6.7):
 *    instructions live only in `system`; the transcript, the question (when
 *    there is one) and a static instructions recap are the only `user` turn
 *    content — never a user-supplied string in `system` (WS4's hard
 *    requirement).
 * 7. **Deliver** (DESIGN §8): a placeholder sent immediately, then edited
 *    with the rendered result; DM opt-in with an in-chat fallback on `403`.
 *
 * Deliberately **not** this workstream's job (see `docs/PLAN.md`, WS10's
 * dependency list — WS1, WS3, WS4 only): cooldown, concurrency, dedupe, daily
 * caps, the global budget hard stop (WS12) and `usage_events` recording
 * (WS12). Those compose around this use case rather than living inside it.
 */
import {
  AnchorNotFoundError,
  CorpusTooLargeError,
  DmForbiddenError,
  EmptyCorpusError,
} from '../../domain/errors.js';
import { assembleCorpus } from '../../domain/corpus/assemble.js';
import { SUMMARIZE } from '../../domain/model/intent.js';
import type { Intent } from '../../domain/model/intent.js';
import { NON_HUMAN_MESSAGE_KINDS } from '../../domain/model/message.js';
import type { StoredMessage } from '../../domain/model/message.js';
import type { AnswerContent, AnswerMeta, DeliveredAnswer, Answer } from '../../domain/model/answer.js';
import type { ChatId, MessageId } from '../../domain/model/ids.js';
import type { ParsedArguments, RangeResolutionContext, ResolvedRange } from '../../domain/model/range.js';
import { ALL_TOPICS, threadScope } from '../../domain/model/scope.js';
import type { Scope } from '../../domain/model/scope.js';
import { resolve } from '../../domain/range/resolve.js';
import { renderAnswer } from '../../domain/render/render-answer.js';
import type { RenderLanguage } from '../../domain/render/language.js';
import { routeModel } from '../llm/router.js';
import { Compactor } from '../compaction/compactor.js';
import { ThrottledProgressReporter } from '../compaction/progress.js';
import type { CompactionProgress } from '../compaction/types.js';
import { answerContentOutput } from '../prompts/output-contracts.js';
import { buildInstructionsRecap, buildSystemPrompt, PROMPT_VERSION } from '../prompts/system-prompt.js';
import type { PromptIntent } from '../prompts/system-prompt.js';
import type { ChatGateway, SendTextParams, SentMessage } from '../ports/driven/chat-gateway.js';
import type { ChatConfigView, Config } from '../ports/driven/config.js';
import type { ChunkStore } from '../ports/driven/chunk-store.js';
import type { Clock } from '../ports/driven/clock.js';
import type { Llm, LlmUserBlock } from '../ports/driven/llm.js';
import type { MessageQueryOptions, MessageStore } from '../ports/driven/message-store.js';
import type { OptOutStore } from '../ports/driven/opt-out-store.js';
import type { SettingsStore } from '../ports/driven/settings-store.js';
import type { InvocationContext, RangeInvocation } from '../ports/driving/invocation.js';
import type { AnswerOutcome, SummarizeRange, SummarizeRangeCommand } from '../ports/driving/summarize-range.js';

/** Everything the shared pipeline needs. Both use cases take exactly this. */
export interface AnswerPipelineDeps {
  readonly messages: MessageStore;
  readonly optOuts: OptOutStore;
  readonly settings: SettingsStore;
  readonly config: Config;
  readonly gateway: ChatGateway;
  readonly llm: Llm;
  readonly clock: Clock;
  /** WS11's compacted-summary cache — reused so map-reduce hits it too. */
  readonly chunks: ChunkStore;
}

const PLACEHOLDER_TEXT: Readonly<Record<RenderLanguage, (count: number) => string>> = {
  pl: (count) => `⏳ Czytam ${String(count)} wiadomości…`,
  en: (count) => `⏳ Reading ${String(count)} messages…`,
};

/** DESIGN §8: "fall back in-chat with 'nie mogę wysłać prywatnie — napisz do mnie /start'". */
const DM_FAILED_TEXT: Readonly<Record<RenderLanguage, string>> = {
  pl: 'nie mogę wysłać prywatnie — napisz do mnie /start',
  en: "I can't send you a DM — send me /start first",
};

/**
 * DESIGN §7 "Over-budget behaviour": "Warn first and suggest a narrower
 * range; compact when the user proceeds." There is no confirmation step to
 * wait on here — no driving port exists for "user proceeded" — so "proceeds"
 * is read as "does not cancel the whole invocation", and the warning is what
 * makes the ensuing compaction visible rather than silent (DESIGN §7: "never
 * silently truncate … and do not silently compact either", per this
 * workstream's brief).
 */
const COMPACTING_WARNING_TEXT: Readonly<Record<RenderLanguage, (messageCount: number) => string>> = {
  pl: (count) =>
    `⚠️ Zakres jest duży (${String(count)} wiadomości) — kompaktuję, to może chwilę potrwać. ` +
    'Rozważ węższy zakres, jeśli to się powtarza.',
  en: (count) =>
    `⚠️ This range is large (${String(count)} messages) — compacting, this may take a while. ` +
    'Consider a narrower range if this keeps happening.',
};

/** DESIGN §8: "carries map-reduce progress (`kompaktuję 3/7`)". */
const COMPACTION_PROGRESS_TEXT: Readonly<Record<RenderLanguage, (progress: CompactionProgress) => string>> = {
  pl: (progress) => `⏳ kompaktuję ${String(progress.done)}/${String(progress.total)}…`,
  en: (progress) => `⏳ compacting ${String(progress.done)}/${String(progress.total)}…`,
};

/**
 * DESIGN §7: "when even the compacted result would exceed the budget" — the
 * genuinely-unservable case `Compactor` itself refuses (`CorpusTooLargeError`
 * thrown mid-compaction). The placeholder must say so rather than sit on a
 * stale "compacting…" line forever.
 */
const TOO_LARGE_EVEN_COMPACTED_TEXT: Readonly<Record<RenderLanguage, string>> = {
  pl: '❌ ten zakres jest zbyt duży nawet po kompaktowaniu — spróbuj węższego zakresu',
  en: '❌ this range is too large to serve even after compacting — try a narrower range',
};

/** The compaction placeholder's receipt once the answer went out by DM instead. */
const DM_SENT_TEXT: Readonly<Record<RenderLanguage, string>> = {
  pl: '✅ wysłano na priv',
  en: '✅ sent via DM',
};

/**
 * The reply-anchor message id this call would resolve against, *before*
 * `resolve()` runs — needed one step earlier than `resolve()` itself, purely
 * to decide which thread to scope the query to (see module docs, point 1).
 * Mirrors exactly the condition under which `resolve()` synthesizes a reply
 * anchor: `parsed.rangeSpec.kind === 'default'` and a reply is present. A
 * literal `replyAnchor` spec is included too, defensively — `parse()` never
 * produces one (DESIGN §2's grammar has no textual anchor token), but the
 * type permits it and `resolve()` honours it.
 */
function anchorMessageId(parsed: ParsedArguments, invocation: InvocationContext): MessageId | null {
  if (parsed.rangeSpec.kind === 'replyAnchor') return parsed.rangeSpec.messageId;
  if (parsed.rangeSpec.kind === 'default') return invocation.replyToMessageId;
  return null;
}

async function determineScope(
  messages: MessageStore,
  chatId: ChatId,
  invocation: InvocationContext,
  parsed: ParsedArguments,
): Promise<Scope> {
  if (parsed.allTopics) return ALL_TOPICS;
  const anchorId = anchorMessageId(parsed, invocation);
  if (anchorId !== null) {
    const anchor = await messages.findById(chatId, anchorId);
    if (anchor !== null) return threadScope(anchor.threadId);
  }
  return threadScope(invocation.threadId);
}

/**
 * Fetches the resolved range, clamping to the corpus horizon on
 * `AnchorNotFoundError` (DESIGN §7, §10: "Anchor older than the horizon →
 * clamp and say so") instead of failing the call outright. A horizon of
 * `null` means the store holds nothing at all in scope, which collapses to
 * `corpus.empty` — there is nothing left to clamp to.
 */
async function fetchRows(
  messages: MessageStore,
  chatId: ChatId,
  range: ResolvedRange,
  options: MessageQueryOptions,
): Promise<{ readonly rows: readonly StoredMessage[]; readonly range: ResolvedRange }> {
  try {
    const rows = await messages.fetchRange(chatId, range, options);
    return { rows, range };
  } catch (error) {
    if (!(error instanceof AnchorNotFoundError)) throw error;
    const horizon = await messages.oldest(chatId, range.scope);
    if (horizon === null) throw new EmptyCorpusError();
    const clampedRange: ResolvedRange = {
      ...range,
      start: { kind: 'instant', ts: horizon.ts },
      clampedToHorizon: true,
    };
    const rows = await messages.fetchRange(chatId, clampedRange, options);
    return { rows, range: clampedRange };
  }
}

/**
 * DESIGN §8: placeholder + throttled edit in-chat; DM opt-in with a `403`
 * fallback.
 *
 * Exported because a dedupe cache hit (DESIGN §9, WS12) delivers an answer
 * this pipeline produced minutes ago and must deliver it *identically* —
 * same rendering, same DM preference, same `403` fallback — with only the
 * `↺ odpowiedź sprzed N min` marker differing. A second copy of this
 * function is a second place for that to drift.
 *
 * `existingPlaceholder`, when given, is a message already sent for this
 * invocation — the compaction path (`compactAndAnswer`) sends its own
 * placeholder up front so it has somewhere to carry the over-budget warning
 * and the throttled map-reduce progress (DESIGN §8) *before* an answer
 * exists to deliver. This function then edits that same message rather than
 * sending a second one, in every delivery branch that would otherwise open
 * with its own `sendText`.
 */
export async function deliverAnswer(
  deps: Pick<AnswerPipelineDeps, 'gateway' | 'settings'>,
  chatId: ChatId,
  invocation: InvocationContext,
  answer: Answer,
  chatConfig: ChatConfigView,
  language: RenderLanguage,
  messageCount: number,
  existingPlaceholder?: SentMessage,
): Promise<DeliveredAnswer> {
  const { gateway, settings } = deps;
  const parts = renderAnswer(answer, {
    language,
    slurWordlist: chatConfig.get('safety').slurs,
    maxChars: chatConfig.get('limits').maxOutputChars,
    maxParts: chatConfig.get('limits').maxOutputParts,
  });
  const [first = '', ...rest] = parts;

  const userId = invocation.invoker.userId;
  const prefs = await settings.getUserPrefs(chatId, userId);
  const wantsDm = prefs?.dmDelivery ?? chatConfig.get('delivery').dmByDefault;
  const linkPreview = chatConfig.get('delivery').linkPreview;

  if (wantsDm) {
    try {
      const messageIds: MessageId[] = [];
      for (const part of parts) {
        const sent = await gateway.sendDirect(userId, directParams(part, linkPreview));
        messageIds.push(sent.messageId);
      }
      // The receipt stays in-chat as a short completion note rather than
      // being left on a stale "compacting…" line (or deleted — a deleted
      // receipt is indistinguishable from the call never having happened).
      if (existingPlaceholder !== undefined) {
        await gateway.editText(chatId, existingPlaceholder.messageId, { text: DM_SENT_TEXT[language] });
      }
      return { answer, delivery: 'dm', threadId: invocation.threadId, messageIds };
    } catch (error) {
      if (!(error instanceof DmForbiddenError)) throw error;
      const notice =
        existingPlaceholder === undefined
          ? await gateway.sendText(chatId, {
              text: DM_FAILED_TEXT[language],
              threadId: invocation.threadId,
              silent: !linkPreview,
            })
          : await editAsNotice(gateway, chatId, existingPlaceholder, DM_FAILED_TEXT[language]);
      const messageIds: MessageId[] = [notice.messageId];
      for (const part of parts) {
        const sent = await gateway.sendText(chatId, inChatParams(part, invocation.threadId, linkPreview));
        messageIds.push(sent.messageId);
      }
      return { answer, delivery: 'in_chat_after_dm_failure', threadId: invocation.threadId, messageIds };
    }
  }

  const placeholder =
    existingPlaceholder ??
    (await gateway.sendText(chatId, {
      text: PLACEHOLDER_TEXT[language](messageCount),
      threadId: invocation.threadId,
      replyToMessageId: invocation.invokedMessageId,
      silent: !linkPreview,
    }));
  await gateway.editText(chatId, placeholder.messageId, { text: first });
  const messageIds: MessageId[] = [placeholder.messageId];
  for (const part of rest) {
    const sent = await gateway.sendText(chatId, inChatParams(part, invocation.threadId, linkPreview));
    messageIds.push(sent.messageId);
  }
  return { answer, delivery: 'in_chat', threadId: invocation.threadId, messageIds };
}

/** `gateway.editText` on an already-sent message, returned in `SentMessage` shape for a uniform call site. */
async function editAsNotice(
  gateway: ChatGateway,
  chatId: ChatId,
  target: SentMessage,
  text: string,
): Promise<SentMessage> {
  await gateway.editText(chatId, target.messageId, { text });
  return target;
}

function inChatParams(text: string, threadId: SendTextParams['threadId'], linkPreview: boolean): SendTextParams {
  return { text, threadId, silent: !linkPreview };
}

function directParams(text: string, linkPreview: boolean): Omit<SendTextParams, 'threadId'> {
  return { text, silent: !linkPreview };
}

interface CompactionContext {
  readonly deps: AnswerPipelineDeps;
  readonly chatId: ChatId;
  readonly invocation: InvocationContext;
  readonly parsed: ParsedArguments;
  readonly chatConfig: ChatConfigView;
  readonly language: RenderLanguage;
  readonly rows: readonly StoredMessage[];
  readonly range: ResolvedRange;
  readonly assembled: { readonly messageCount: number; readonly gapCount: number };
  readonly timeZone: RangeResolutionContext['timeZone'];
  readonly intent: Intent;
  readonly promptIntent: PromptIntent;
  readonly maxInputTokens: number;
  /** The single-shot pre-flight count that tripped `maxInputTokens` — the router's `inputTokens` hint. */
  readonly tokenCount: number;
}

/**
 * DESIGN §7 "Over-budget behaviour" + "Compaction (map-reduce)", wired to
 * WS11's `Compactor`. Runs once `runAnswerPipeline` has already decided the
 * raw corpus is over `limits.maxInputTokens`:
 *
 * 1. **Warn, visibly, before compacting** — its own placeholder, not the
 *    normal one, so the "this is large" notice is never silently skipped in
 *    favour of just doing the (slow, costly) work.
 * 2. **Route map → the cheap model, reduce → the strong one** through the
 *    same `routeModel` every other call uses — no second routing path.
 * 3. **Progress** through `ThrottledProgressReporter` into that same
 *    placeholder (DESIGN §8: ~1 edit / 3s).
 * 4. **Deliver** through the same `deliverAnswer` the single-shot path uses,
 *    handing it the already-sent placeholder so it edits rather than sends
 *    a second message.
 *
 * `corpus.too_large` only reaches this function's caller when `Compactor`
 * itself throws `CorpusTooLargeError` — the genuinely unservable case (an
 * atomic unit, or a plateaued reduce round, that still will not fit
 * `maxInputTokens`) — never merely because the raw corpus tripped the
 * threshold that got us here.
 */
async function compactAndAnswer(ctx: CompactionContext): Promise<AnswerOutcome> {
  const {
    deps,
    chatId,
    invocation,
    parsed,
    chatConfig,
    language,
    rows,
    range,
    assembled,
    timeZone,
    intent,
    promptIntent,
    maxInputTokens,
    tokenCount,
  } = ctx;
  const { gateway, llm, clock, settings, chunks } = deps;
  const linkPreview = chatConfig.get('delivery').linkPreview;

  // DESIGN §7: warn first, visibly — this is the placeholder for the whole
  // compaction, not the single-shot one `deliverAnswer` would otherwise send.
  const placeholder = await gateway.sendText(chatId, {
    text: COMPACTING_WARNING_TEXT[language](assembled.messageCount),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
    silent: !linkPreview,
  });

  const modelsConfig = chatConfig.get('models');
  // DESIGN §7: "Map phase uses a cheap model, reduce phase the strong one" —
  // the existing router, called with `phase: 'map'` / `'reduce'` exactly as
  // any other routing rule would be, never a second mechanism.
  const mapModel = routeModel(modelsConfig, { phase: 'map', chatId, inputTokens: tokenCount });
  const reduceModel = routeModel(modelsConfig, { phase: 'reduce', chatId, inputTokens: tokenCount });
  // Neither model's own output cap may be exceeded, so the shared knob is the
  // smaller of the two entries actually in play.
  const maxOutputTokens = Math.min(mapModel.entry.maxOutputTokens, reduceModel.entry.maxOutputTokens);

  const progress = new ThrottledProgressReporter({
    gateway,
    clock,
    target: { chatId, messageId: placeholder.messageId },
    throttleMs: chatConfig.get('delivery').editThrottleMs,
    render: (report: CompactionProgress) => COMPACTION_PROGRESS_TEXT[language](report),
  });

  const compactor = new Compactor({ llm, chunks, clock });

  let result;
  try {
    result = await compactor.compact({
      chatId,
      messages: rows,
      timeZone,
      compactThreshold: chatConfig.get('limits').compactThreshold,
      models: { map: mapModel.entry.model, reduce: reduceModel.entry.model },
      maxOutputTokens,
      maxInputTokens,
      promptVersion: PROMPT_VERSION,
      language,
      intent: promptIntent,
      question: intent.kind === 'answer' ? intent.question : null,
      // WS10's own richer corpus renderer (gap disclosure, media captions) —
      // `Compactor`'s built-in `defaultFormatTranscript` is only a fallback
      // for a caller with no such renderer of its own.
      formatBucket: (bucketMessages, bucketTimeZone) =>
        assembleCorpus(bucketMessages, { timeZone: bucketTimeZone }).transcript,
      progress,
    });
  } catch (error) {
    if (error instanceof CorpusTooLargeError) {
      await gateway.editText(chatId, placeholder.messageId, { text: TOO_LARGE_EVEN_COMPACTED_TEXT[language] });
      return { kind: 'refused', code: 'corpus.too_large' };
    }
    throw error;
  }

  const meta: AnswerMeta = {
    chatId,
    scope: range.scope,
    // No forum-topic-name lookup on `ChatGateway` (DESIGN §3: the port is
    // frozen); the header falls back to `#threadId` when this is `null`.
    topicLabel: null,
    range,
    spec: parsed.rangeSpec,
    messageCount: assembled.messageCount,
    gapCount: assembled.gapCount,
    cached: null,
    model: result.model,
    promptVersion: result.promptVersion,
  };
  const answer: Answer = { content: result.content, meta };

  const delivered = await deliverAnswer(
    { gateway, settings },
    chatId,
    invocation,
    answer,
    chatConfig,
    language,
    assembled.messageCount,
    placeholder,
  );
  return { kind: 'answered', delivered };
}

/**
 * The shared engine behind `SummarizeRange` and `AnswerQuestion`. See the
 * module docstring for the full pipeline; `intent` is the one thing that
 * differs between the two callers.
 */
export async function runAnswerPipeline(
  deps: AnswerPipelineDeps,
  command: RangeInvocation,
  intent: Intent,
): Promise<AnswerOutcome> {
  const { messages, optOuts, settings, config, gateway, llm, clock } = deps;
  const { invocation, parsed } = command;
  const chatId = invocation.chatId;
  const chatConfig = await config.forChat(chatId);
  const language: RenderLanguage = chatConfig.get('bot').language;

  try {
    const scope = await determineScope(messages, chatId, invocation, parsed);
    const now = clock.now();
    const timeZone = chatConfig.get('timezone').default;
    const storedHorizonRow = await messages.oldest(chatId, scope);

    const rangeCtx: RangeResolutionContext = {
      now,
      timeZone,
      scope,
      replyAnchor: invocation.replyToMessageId,
      defaultRangeDays: chatConfig.get('limits').defaultRangeDays,
      maxMessages: chatConfig.get('limits').maxMessagesPerRange,
      storedHorizon: storedHorizonRow?.ts ?? null,
    };
    const initialRange = resolve(parsed.rangeSpec, rangeCtx);

    const botIdentity = await gateway.getMe();
    const optedOut = await optOuts.listOptedOut(chatId);
    const excludeUserIds = [botIdentity.userId, ...optedOut];
    // DESIGN §2: "-N counts stored human messages only" — the store applies
    // this option before the lastN cut, so it is scoped to exactly that case
    // (see module docs, point 3).
    const excludeKinds = initialRange.start.kind === 'lastN' ? NON_HUMAN_MESSAGE_KINDS : undefined;
    const queryOptions: MessageQueryOptions = { excludeUserIds, excludeKinds };

    const { rows, range } = await fetchRows(messages, chatId, initialRange, queryOptions);
    if (rows.length === 0) throw new EmptyCorpusError();

    const assembled = assembleCorpus(rows, { timeZone });
    if (assembled.messageCount === 0) throw new EmptyCorpusError();

    const promptIntent: PromptIntent = intent.kind;
    const system = buildSystemPrompt({ language, phase: 'single', intent: promptIntent });
    const userBlocks: LlmUserBlock[] = [{ kind: 'transcript', text: assembled.transcript }];
    if (intent.kind === 'answer') {
      userBlocks.push({ kind: 'question', text: intent.question });
    }
    userBlocks.push({
      kind: 'instructions_recap',
      text: buildInstructionsRecap({ language, phase: 'single', intent: promptIntent }),
    });

    const resolvedModel = routeModel(chatConfig.get('models'), { phase: 'single', chatId });
    const maxInputTokens = chatConfig.get('limits').maxInputTokens;
    const tokenCount = await llm.countTokens({ model: resolvedModel.entry.model, system, userBlocks });
    if (tokenCount > maxInputTokens) {
      // DESIGN §7: "never silently truncate … warn and compact." Warn
      // (a visible placeholder notice, not a throw) then hand off to WS11's
      // `Compactor` — `corpus.too_large` is reserved for the case it detects
      // as genuinely unservable, not for merely being over this threshold.
      return await compactAndAnswer({
        deps,
        chatId,
        invocation,
        parsed,
        chatConfig,
        language,
        rows,
        range,
        assembled,
        timeZone,
        intent,
        promptIntent,
        maxInputTokens,
        tokenCount,
      });
    }

    const response = await llm.complete<AnswerContent>({
      model: resolvedModel.entry.model,
      system,
      userBlocks,
      output: answerContentOutput,
      maxOutputTokens: resolvedModel.entry.maxOutputTokens,
      phase: 'single',
    });

    const meta: AnswerMeta = {
      chatId,
      scope: range.scope,
      // No forum-topic-name lookup on `ChatGateway` (DESIGN §3: the port is
      // frozen); the header falls back to `#threadId` when this is `null`.
      topicLabel: null,
      range,
      spec: parsed.rangeSpec,
      messageCount: assembled.messageCount,
      gapCount: assembled.gapCount,
      cached: null,
      model: response.model,
      promptVersion: PROMPT_VERSION,
    };
    const answer: Answer = { content: response.structured, meta };

    const delivered = await deliverAnswer(
      { gateway, settings },
      chatId,
      invocation,
      answer,
      chatConfig,
      language,
      assembled.messageCount,
    );
    return { kind: 'answered', delivered };
  } catch (error) {
    if (error instanceof EmptyCorpusError) return { kind: 'refused', code: 'corpus.empty' };
    if (error instanceof CorpusTooLargeError) return { kind: 'refused', code: 'corpus.too_large' };
    throw error;
  }
}

export class SummarizeRangeUseCase implements SummarizeRange {
  readonly #deps: AnswerPipelineDeps;

  constructor(deps: AnswerPipelineDeps) {
    this.#deps = deps;
  }

  async execute(command: SummarizeRangeCommand): Promise<AnswerOutcome> {
    return await runAnswerPipeline(this.#deps, command, SUMMARIZE);
  }
}
