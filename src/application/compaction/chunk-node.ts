/**
 * Small pure helpers `compactor.ts` uses to turn `ChunkNode`s into the
 * `Chunk`/`ChunkKey` shape `ChunkStore` speaks, and back.
 */
import { asMessageId } from '../../domain/model/ids.js';
import type { MessageId, ThreadId } from '../../domain/model/ids.js';
import type { ChunkSummaryContent } from '../../domain/model/answer.js';
import type { ChunkNode } from './types.js';

/**
 * `Chunk.text` for a compacted node: plain text, deterministic given the
 * structured content, and itself readable as the next round's
 * `<chunk_summaries>` input. Not meant to be parsed back — only ever
 * concatenated into a later prompt or displayed as a cached chunk's `text`.
 */
export function serializeChunkSummary(content: ChunkSummaryContent): string {
  const lines = [`Tone: ${content.tone}`, '', content.summary];
  if (content.keyPoints.length > 0) {
    lines.push('', 'Key points:', ...content.keyPoints.map((point) => `- ${point}`));
  }
  return lines.join('\n');
}

/** Joins nodes' texts for a `chunk_summaries` user block, one node per paragraph. */
export function joinNodeTexts(nodes: readonly ChunkNode[]): string {
  return nodes.map((node) => node.text).join('\n\n---\n\n');
}

/** The smallest message id among a set of messages/nodes — never assumed to be the first element. */
export function minMessageId(ids: readonly MessageId[]): MessageId {
  return ids.reduce((min, id) => (id < min ? id : min), ids[0] as MessageId);
}

/** The largest message id among a set of messages/nodes. */
export function maxMessageId(ids: readonly MessageId[]): MessageId {
  return ids.reduce((max, id) => (id > max ? id : max), ids[0] as MessageId);
}

/** Re-brands a plain number already known to be a valid message id (defensive at module edges). */
export function messageId(value: number): MessageId {
  return asMessageId(value);
}

export interface ThreadUniformity {
  /** The shared thread, or `null` when the group spans more than one thread. */
  readonly threadId: ThreadId | null;
  /** `false` when the group mixes threads — such a node is never cached (see `compactor.ts`). */
  readonly uniform: boolean;
}

/**
 * A group of nodes is only safe to cache as a single `Chunk` when every node
 * in it shares one thread — otherwise `[firstMsgId, lastMsgId]` would silently
 * claim to represent one forum topic while actually spanning several (only
 * possible under an `all`-scoped range, DESIGN §2). Non-uniform groups are
 * still reduced; they are just never written to `ChunkStore`.
 */
export function threadUniformity(nodes: readonly ChunkNode[]): ThreadUniformity {
  const first = nodes[0]?.threadId ?? null;
  const uniform = nodes.every((node) => node.threadId === first);
  return { threadId: uniform ? first : null, uniform };
}
