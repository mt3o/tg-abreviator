/**
 * Map-reduce compaction with a chunk cache (DESIGN §7 "Compaction", PLAN WS11).
 *
 * "**One threshold applied recursively at every level.** Concatenate; if over
 * `COMPACT_THRESHOLD`, split and summarize each part; repeat on the results."
 *
 * `Compactor.compact()` implements exactly that loop:
 *
 * 1. Partition the corpus by thread (`partitionByKey`), then bucket each
 *    thread's messages into 6h windows (`bucketByTime`), then split any
 *    over-sized bucket further by a deterministic weight budget
 *    (`groupByWeight`) — the "hybrid bucketing" DESIGN §7 describes.
 * 2. Map-summarize every leaf bucket on the cheap model, through the chunk
 *    cache (`ChunkStore`), keyed on `[threadId, firstMsgId, lastMsgId, model,
 *    promptVersion]` — a cache miss exactly when the prompt changes, DESIGN
 *    §7's whole point of including `promptVersion` in the key.
 * 3. While the concatenated chunk texts would still be too large for one
 *    call, group them and reduce each group into a new, smaller set of
 *    chunks on the strong model — same cache, same key shape, because an
 *    intermediate reduce output is exactly as cacheable as a leaf.
 * 4. Once what remains fits, issue the one call that actually answers the
 *    request (`AnswerContent`) — never cached, because that call is the
 *    delivered answer, not a reusable intermediate.
 */
import { CorpusTooLargeError, EmptyCorpusError, InvalidValueError } from '../../domain/errors.js';
import { bucketByTime, groupByWeight, partitionByKey } from '../../domain/buckets.js';
import type { ThreadId } from '../../domain/model/ids.js';
import type { AnswerContent } from '../../domain/model/answer.js';
import type { ChunkKey } from '../../domain/model/chunk.js';
import type { StoredMessage } from '../../domain/model/message.js';
import { defaultFormatTranscript } from './format-transcript.js';
import {
  joinNodeTexts,
  maxMessageId,
  minMessageId,
  serializeChunkSummary,
  threadUniformity,
} from './chunk-node.js';
import { buildInstructionsRecap, buildSystemPrompt } from '../prompts/system-prompt.js';
import type { SystemPromptOptions } from '../prompts/system-prompt.js';
import { answerContentOutput, chunkSummaryContentOutput } from '../prompts/output-contracts.js';
import type { Clock } from '../ports/driven/clock.js';
import type { ChunkStore } from '../ports/driven/chunk-store.js';
import type { Llm, LlmUserBlock } from '../ports/driven/llm.js';
import type { CompactionCallRecord, CompactionRequest, CompactionResult, ChunkNode } from './types.js';

export interface CompactionDeps {
  readonly llm: Llm;
  readonly chunks: ChunkStore;
  readonly clock: Clock;
}

function messageWeight(message: StoredMessage): number {
  return (message.text?.length ?? 0) + (message.displayName?.length ?? 0) + 16;
}

function nodeWeight(node: ChunkNode): number {
  return node.text.length;
}

/**
 * Characters per token, **derived from one real `Llm.countTokens()`
 * measurement** of `text` — never a fixed guess (DESIGN §7: "Token counting
 * via `messages.count_tokens`, never `tiktoken` and never an estimate.
 * Polish tokenizes worse than English and the difference matters."). The
 * ratio itself is only ever used to convert `compactThreshold` (in tokens)
 * into a character budget for `groupByWeight`'s shaping heuristic — it never
 * substitutes for an actual token count anywhere a real one is required, and
 * it is recomputed fresh for every bucket and every reduce round rather than
 * reused, so it always reflects this content.
 */
function charsPerToken(text: string, measuredTokens: number): number {
  return text.length / Math.max(measuredTokens, 1);
}

interface PendingLeaf {
  readonly threadId: ThreadId | null;
  readonly messages: readonly StoredMessage[];
}

export class Compactor {
  readonly #deps: CompactionDeps;

  constructor(deps: CompactionDeps) {
    this.#deps = deps;
  }

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    if (request.intent === 'answer' && (request.question === null || request.question.trim().length === 0)) {
      throw new InvalidValueError('compaction request has intent "answer" but carries no question');
    }
    if (request.messages.length === 0) {
      throw new EmptyCorpusError();
    }

    const calls: CompactionCallRecord[] = [];
    const formatBucket = request.formatBucket ?? defaultFormatTranscript;

    const pendingLeaves = await this.#planLeaves(request, formatBucket);

    let nodes: ChunkNode[] = [];
    let mapDone = 0;
    for (const leaf of pendingLeaves) {
      nodes.push(await this.#mapLeaf(request, leaf, formatBucket, calls));
      mapDone += 1;
      await request.progress?.report({
        phase: 'map',
        level: 0,
        done: mapDone,
        total: pendingLeaves.length,
      });
    }
    const leafChunkCount = nodes.length;

    let levels = 0;
    while (nodes.length > 1) {
      const combinedText = joinNodeTexts(nodes);
      const measured = await this.#reduceTokens(request, combinedText);
      // Everything already fits in one call — no reduce round needed, go
      // straight to the final call below.
      if (measured <= request.compactThreshold) break;

      const maxWeight = request.compactThreshold * charsPerToken(combinedText, measured);
      const groups = groupByWeight(nodes, nodeWeight, maxWeight);
      // No group could combine two nodes (every node is already at or over
      // the weight budget on its own): further looping would never shrink
      // the set. Stop and let the final call absorb what remains, best
      // effort — DESIGN says "repeat on the results", not "repeat forever".
      if (groups.length === nodes.length) {
        // Best effort is still bounded by the one ceiling that is not a
        // knob: a plateaued reduce whose combined text would still blow
        // `maxInputTokens` is the genuinely-unservable case (constraints:
        // "when even the compacted result would exceed the budget"). Refuse
        // rather than let `#finalReduce` make a call that cannot succeed.
        if (request.maxInputTokens !== undefined && measured > request.maxInputTokens) {
          throw new CorpusTooLargeError(measured, request.maxInputTokens);
        }
        break;
      }

      levels += 1;
      const nextNodes: ChunkNode[] = [];
      let reduceDone = 0;
      for (const group of groups) {
        const combined =
          group.length === 1 ? (group[0] as ChunkNode) : await this.#reduceGroup(request, group, levels, calls);
        nextNodes.push(combined);
        reduceDone += 1;
        await request.progress?.report({
          phase: 'reduce',
          level: levels,
          done: reduceDone,
          total: groups.length,
        });
      }
      nodes = nextNodes;
    }

    const content = await this.#finalReduce(request, nodes, levels, calls);
    return {
      content,
      model: request.models.reduce,
      promptVersion: request.promptVersion,
      calls,
      leafChunkCount,
      levels,
    };
  }

  /**
   * Thread partition -> time buckets -> per-bucket token measurement -> weight
   * subdivision. A bucket that already fits `compactThreshold` becomes one
   * leaf untouched; an over-threshold bucket is split with a char budget
   * derived from measuring *that bucket's own* transcript, never a constant.
   */
  async #planLeaves(
    request: CompactionRequest,
    formatBucket: NonNullable<CompactionRequest['formatBucket']>,
  ): Promise<readonly PendingLeaf[]> {
    const threadGroups = partitionByKey(request.messages, (message) => String(message.threadId ?? 'null'));
    const leaves: PendingLeaf[] = [];
    for (const group of threadGroups) {
      const threadId = group[0]?.threadId ?? null;
      const timeBuckets = bucketByTime(group, {
        timeZone: request.timeZone,
        ...(request.bucketHours === undefined ? {} : { bucketHours: request.bucketHours }),
      });
      for (const bucket of timeBuckets) {
        const wholeText = formatBucket(bucket.messages, request.timeZone);
        const measured = await this.#bucketTokens(request, wholeText);
        if (measured <= request.compactThreshold) {
          leaves.push({ threadId, messages: bucket.messages });
          continue;
        }
        if (bucket.messages.length === 1) {
          // A single message cannot be split any further — it is the atomic
          // unit. Sitting over `compactThreshold` alone is fine (DESIGN §7:
          // "the threshold is a cost and attention knob, not a fit
          // constraint"); sitting over `maxInputTokens` is not, because no
          // call this leaf could ever make would fit (DESIGN §7: "one
          // 10,000-character message can blow a … budget by itself").
          if (request.maxInputTokens !== undefined && measured > request.maxInputTokens) {
            throw new CorpusTooLargeError(measured, request.maxInputTokens);
          }
          leaves.push({ threadId, messages: bucket.messages });
          continue;
        }
        const maxWeight = request.compactThreshold * charsPerToken(wholeText, measured);
        for (const leafMessages of groupByWeight(bucket.messages, messageWeight, maxWeight)) {
          leaves.push({ threadId, messages: leafMessages });
        }
      }
    }
    return leaves;
  }

  /** DESIGN §7: "checked with `count_tokens` before every call" — here, before deciding to split at all. */
  async #bucketTokens(request: CompactionRequest, transcript: string): Promise<number> {
    const promptOptions: SystemPromptOptions = {
      language: request.language,
      phase: 'map',
      intent: request.intent,
    };
    return await this.#deps.llm.countTokens({
      model: request.models.map,
      system: buildSystemPrompt(promptOptions),
      userBlocks: [{ kind: 'transcript', text: transcript }],
    });
  }

  async #reduceTokens(request: CompactionRequest, combinedText: string): Promise<number> {
    const promptOptions: SystemPromptOptions = {
      language: request.language,
      phase: 'reduce',
      intent: 'summarize',
    };
    return await this.#deps.llm.countTokens({
      model: request.models.reduce,
      system: buildSystemPrompt(promptOptions),
      userBlocks: [{ kind: 'chunk_summaries', text: combinedText }],
    });
  }

  async #mapLeaf(
    request: CompactionRequest,
    leaf: PendingLeaf,
    formatBucket: NonNullable<CompactionRequest['formatBucket']>,
    calls: CompactionCallRecord[],
  ): Promise<ChunkNode> {
    const firstMsgId = minMessageId(leaf.messages.map((message) => message.messageId));
    const lastMsgId = maxMessageId(leaf.messages.map((message) => message.messageId));
    const key: ChunkKey = {
      threadId: leaf.threadId,
      firstMsgId,
      lastMsgId,
      model: request.models.map,
      promptVersion: request.promptVersion,
    };

    const cached = await this.#deps.chunks.find(request.chatId, key);
    if (cached !== null) {
      calls.push({ phase: 'map', level: 0, model: request.models.map, cached: true, usage: null });
      return { threadId: leaf.threadId, firstMsgId, lastMsgId, text: cached.text };
    }

    const promptOptions: SystemPromptOptions = {
      language: request.language,
      phase: 'map',
      intent: request.intent,
    };
    const response = await this.#deps.llm.complete({
      model: request.models.map,
      system: buildSystemPrompt(promptOptions),
      userBlocks: [
        { kind: 'transcript', text: formatBucket(leaf.messages, request.timeZone) },
        { kind: 'instructions_recap', text: buildInstructionsRecap(promptOptions) },
      ],
      output: chunkSummaryContentOutput,
      maxOutputTokens: request.maxOutputTokens,
      phase: 'map',
    });
    const text = serializeChunkSummary(response.structured);

    await this.#deps.chunks.save(request.chatId, {
      chatId: request.chatId,
      threadId: leaf.threadId,
      firstMsgId,
      lastMsgId,
      model: request.models.map,
      promptVersion: request.promptVersion,
      text,
      createdAt: this.#deps.clock.now(),
    });
    calls.push({ phase: 'map', level: 0, model: request.models.map, cached: false, usage: response.usage });
    return { threadId: leaf.threadId, firstMsgId, lastMsgId, text };
  }

  async #reduceGroup(
    request: CompactionRequest,
    group: readonly ChunkNode[],
    level: number,
    calls: CompactionCallRecord[],
  ): Promise<ChunkNode> {
    const firstMsgId = minMessageId(group.map((node) => node.firstMsgId));
    const lastMsgId = maxMessageId(group.map((node) => node.lastMsgId));
    const { threadId, uniform } = threadUniformity(group);

    if (uniform) {
      const key: ChunkKey = {
        threadId,
        firstMsgId,
        lastMsgId,
        model: request.models.reduce,
        promptVersion: request.promptVersion,
      };
      const cached = await this.#deps.chunks.find(request.chatId, key);
      if (cached !== null) {
        calls.push({ phase: 'reduce', level, model: request.models.reduce, cached: true, usage: null });
        return { threadId, firstMsgId, lastMsgId, text: cached.text };
      }
    }

    // Intermediate rounds only ever condense; the question is answered once,
    // in `#finalReduce`, never here.
    const promptOptions: SystemPromptOptions = {
      language: request.language,
      phase: 'reduce',
      intent: 'summarize',
    };
    const response = await this.#deps.llm.complete({
      model: request.models.reduce,
      system: buildSystemPrompt(promptOptions),
      userBlocks: [
        { kind: 'chunk_summaries', text: joinNodeTexts(group) },
        { kind: 'instructions_recap', text: buildInstructionsRecap(promptOptions) },
      ],
      output: chunkSummaryContentOutput,
      maxOutputTokens: request.maxOutputTokens,
      phase: 'reduce',
    });
    const text = serializeChunkSummary(response.structured);

    // Never cache a node that spans more than one thread (only possible under
    // an `all`-scoped range) — a `Chunk` can only claim one `threadId`
    // (`chunk-node.ts`, `threadUniformity`).
    if (uniform) {
      await this.#deps.chunks.save(request.chatId, {
        chatId: request.chatId,
        threadId,
        firstMsgId,
        lastMsgId,
        model: request.models.reduce,
        promptVersion: request.promptVersion,
        text,
        createdAt: this.#deps.clock.now(),
      });
    }
    calls.push({ phase: 'reduce', level, model: request.models.reduce, cached: false, usage: response.usage });
    return { threadId, firstMsgId, lastMsgId, text };
  }

  async #finalReduce(
    request: CompactionRequest,
    nodes: readonly ChunkNode[],
    level: number,
    calls: CompactionCallRecord[],
  ): Promise<AnswerContent> {
    const promptOptions: SystemPromptOptions = {
      language: request.language,
      phase: 'reduce',
      intent: request.intent,
    };
    const userBlocks: LlmUserBlock[] = [{ kind: 'chunk_summaries', text: joinNodeTexts(nodes) }];
    if (request.intent === 'answer') {
      // `request.question` is guaranteed non-null and non-empty by the guard
      // at the top of `compact()`.
      userBlocks.push({ kind: 'question', text: request.question as string });
    }
    userBlocks.push({ kind: 'instructions_recap', text: buildInstructionsRecap(promptOptions) });

    const response = await this.#deps.llm.complete({
      model: request.models.reduce,
      system: buildSystemPrompt(promptOptions),
      userBlocks,
      output: answerContentOutput,
      maxOutputTokens: request.maxOutputTokens,
      phase: 'reduce',
    });
    calls.push({ phase: 'reduce', level, model: request.models.reduce, cached: false, usage: response.usage });
    await request.progress?.report({ phase: 'reduce', level, done: 1, total: 1 });
    return response.structured;
  }
}
