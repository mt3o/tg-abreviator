/**
 * Small pure helpers in `chunk-node.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  joinNodeTexts,
  maxMessageId,
  minMessageId,
  serializeChunkSummary,
  threadUniformity,
} from '../../../src/application/compaction/chunk-node.js';
import { asMessageId, asThreadId } from '../../../src/domain/model/ids.js';
import type { ChunkNode } from '../../../src/application/compaction/types.js';

describe('serializeChunkSummary', () => {
  it('renders tone and summary with no key points', () => {
    const text = serializeChunkSummary({ summary: 'a short summary', keyPoints: [], tone: 'neutral' });
    expect(text).toBe('Tone: neutral\n\na short summary');
  });

  it('appends a bulleted key points section when present', () => {
    const text = serializeChunkSummary({
      summary: 'a short summary',
      keyPoints: ['first point', 'second point'],
      tone: 'heated',
    });
    expect(text).toBe(
      ['Tone: heated', '', 'a short summary', '', 'Key points:', '- first point', '- second point'].join('\n'),
    );
  });
});

describe('joinNodeTexts', () => {
  it('joins node texts with a paragraph separator, in order', () => {
    const nodes: ChunkNode[] = [
      { threadId: null, firstMsgId: asMessageId(1), lastMsgId: asMessageId(1), text: 'a' },
      { threadId: null, firstMsgId: asMessageId(2), lastMsgId: asMessageId(2), text: 'b' },
    ];
    expect(joinNodeTexts(nodes)).toBe('a\n\n---\n\nb');
  });

  it('is the identity for a single node', () => {
    const nodes: ChunkNode[] = [{ threadId: null, firstMsgId: asMessageId(1), lastMsgId: asMessageId(1), text: 'a' }];
    expect(joinNodeTexts(nodes)).toBe('a');
  });
});

describe('minMessageId / maxMessageId', () => {
  it('find the extremes regardless of input order', () => {
    const ids = [asMessageId(5), asMessageId(1), asMessageId(9), asMessageId(3)];
    expect(minMessageId(ids)).toBe(asMessageId(1));
    expect(maxMessageId(ids)).toBe(asMessageId(9));
  });

  it('a synthetic gap-marker id (negative) can be the minimum', () => {
    const ids = [asMessageId(-2), asMessageId(1), asMessageId(3)];
    expect(minMessageId(ids)).toBe(asMessageId(-2));
    expect(maxMessageId(ids)).toBe(asMessageId(3));
  });

  it('a single-element array returns that element for both', () => {
    expect(minMessageId([asMessageId(7)])).toBe(asMessageId(7));
    expect(maxMessageId([asMessageId(7)])).toBe(asMessageId(7));
  });
});

describe('threadUniformity', () => {
  const THREAD_A = asThreadId(1);
  const THREAD_B = asThreadId(2);

  function node(threadId: typeof THREAD_A | null): ChunkNode {
    return { threadId, firstMsgId: asMessageId(1), lastMsgId: asMessageId(1), text: 't' };
  }

  it('is uniform when every node shares the same real thread', () => {
    const result = threadUniformity([node(THREAD_A), node(THREAD_A)]);
    expect(result).toEqual({ threadId: THREAD_A, uniform: true });
  });

  it('is uniform when every node shares General (null)', () => {
    const result = threadUniformity([node(null), node(null)]);
    expect(result).toEqual({ threadId: null, uniform: true });
  });

  it('is not uniform when threads differ, and threadId is null in that case', () => {
    const result = threadUniformity([node(THREAD_A), node(THREAD_B)]);
    expect(result).toEqual({ threadId: null, uniform: false });
  });

  it('is not uniform when one node is General and another is a real topic', () => {
    const result = threadUniformity([node(null), node(THREAD_A)]);
    expect(result.uniform).toBe(false);
  });

  it('a single-node group is trivially uniform', () => {
    expect(threadUniformity([node(THREAD_A)])).toEqual({ threadId: THREAD_A, uniform: true });
  });
});
