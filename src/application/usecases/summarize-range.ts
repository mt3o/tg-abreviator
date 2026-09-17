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
 *    `limits.maxInputTokens`. Over it, this refuses with `corpus.too_large`
 *    rather than truncating (DESIGN §7: "never silently truncate") — the
 *    warn-then-compact half of that rule is WS11's map-reduce path, not yet
 *    wired in.
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
import { answerContentOutput } from '../prompts/output-contracts.js';
import { buildInstructionsRecap, buildSystemPrompt, PROMPT_VERSION } from '../prompts/system-prompt.js';
import type { PromptIntent } from '../prompts/system-prompt.js';
import type { ChatGateway, SendTextParams } from '../ports/driven/chat-gateway.js';
import type { ChatConfigView, Config } from '../ports/driven/config.js';
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
 */
export async function deliverAnswer(
  deps: Pick<AnswerPipelineDeps, 'gateway' | 'settings'>,
  chatId: ChatId,
  invocation: InvocationContext,
  answer: Answer,
  chatConfig: ChatConfigView,
  language: RenderLanguage,
  messageCount: number,
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
      return { answer, delivery: 'dm', threadId: invocation.threadId, messageIds };
    } catch (error) {
      if (!(error instanceof DmForbiddenError)) throw error;
      const notice = await gateway.sendText(chatId, {
        text: DM_FAILED_TEXT[language],
        threadId: invocation.threadId,
        silent: !linkPreview,
      });
      const messageIds: MessageId[] = [notice.messageId];
      for (const part of parts) {
        const sent = await gateway.sendText(chatId, inChatParams(part, invocation.threadId, linkPreview));
        messageIds.push(sent.messageId);
      }
      return { answer, delivery: 'in_chat_after_dm_failure', threadId: invocation.threadId, messageIds };
    }
  }

  const placeholder = await gateway.sendText(chatId, {
    text: PLACEHOLDER_TEXT[language](messageCount),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
    silent: !linkPreview,
  });
  await gateway.editText(chatId, placeholder.messageId, { text: first });
  const messageIds: MessageId[] = [placeholder.messageId];
  for (const part of rest) {
    const sent = await gateway.sendText(chatId, inChatParams(part, invocation.threadId, linkPreview));
    messageIds.push(sent.messageId);
  }
  return { answer, delivery: 'in_chat', threadId: invocation.threadId, messageIds };
}

function inChatParams(text: string, threadId: SendTextParams['threadId'], linkPreview: boolean): SendTextParams {
  return { text, threadId, silent: !linkPreview };
}

function directParams(text: string, linkPreview: boolean): Omit<SendTextParams, 'threadId'> {
  return { text, silent: !linkPreview };
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
      // DESIGN §7: "never silently truncate … warn and compact." Compaction
      // (WS11) is not this workstream's dependency; this is the "warn" half.
      throw new CorpusTooLargeError(tokenCount, maxInputTokens);
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
