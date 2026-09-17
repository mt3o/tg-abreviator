import { describe, expect, it } from 'vitest';

import { TONES } from '../../domain/model/answer.js';
import {
  answerContentOutput,
  answerContentSchema,
  chunkSummaryContentOutput,
  chunkSummaryContentSchema,
} from './output-contracts.js';

const VALID_ANSWER = {
  summary: 'Ola and Marek agreed to ship on Friday.',
  keyPoints: ['ship on Friday', 'Marek owns the release notes'],
  unanswered: ['who is on call over the weekend'],
  tone: 'neutral',
};

const VALID_CHUNK = {
  summary: 'A discussion about the Friday release.',
  keyPoints: ['release moved to Friday'],
  tone: 'technical',
};

describe('answerContentOutput (reduce / single-shot)', () => {
  it('has a stable name used as the provider format name', () => {
    expect(answerContentOutput.name).toBe('answer_content');
  });

  it('accepts a well-formed AnswerContent payload', () => {
    expect(answerContentOutput.parse(VALID_ANSWER)).toEqual(VALID_ANSWER);
  });

  it('every DESIGN-mandated field is required: summary, key_points[], unanswered[], tone', () => {
    for (const field of ['summary', 'keyPoints', 'unanswered', 'tone']) {
      const { [field]: _omitted, ...withoutField } = VALID_ANSWER as Record<string, unknown>;
      expect(() => answerContentOutput.parse(withoutField)).toThrow();
    }
  });

  it('rejects an unknown extra field — fixed fields only, no free-text escape hatch (DESIGN §6.7)', () => {
    expect(() => answerContentOutput.parse({ ...VALID_ANSWER, note: 'sneaky' })).toThrow();
  });

  it('rejects an empty summary or key point', () => {
    expect(() => answerContentOutput.parse({ ...VALID_ANSWER, summary: '' })).toThrow();
    expect(() => answerContentOutput.parse({ ...VALID_ANSWER, keyPoints: [''] })).toThrow();
  });

  it('rejects a tone outside the domain Tone union', () => {
    expect(() => answerContentOutput.parse({ ...VALID_ANSWER, tone: 'furious' })).toThrow();
  });

  it('accepts every value of the domain Tone union — the schema and the domain type stay in sync', () => {
    for (const tone of TONES) {
      expect(() => answerContentOutput.parse({ ...VALID_ANSWER, tone })).not.toThrow();
    }
  });

  it('exposes a JSON Schema object naming exactly the four required fields', () => {
    const schema = answerContentOutput.jsonSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(new Set(schema.required)).toEqual(new Set(['summary', 'keyPoints', 'unanswered', 'tone']));
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['keyPoints', 'summary', 'tone', 'unanswered'].sort(),
    );
  });
});

describe('chunkSummaryContentOutput (map phase)', () => {
  it('has a stable name distinct from the reduce contract', () => {
    expect(chunkSummaryContentOutput.name).toBe('chunk_summary_content');
    expect(chunkSummaryContentOutput.name).not.toBe(answerContentOutput.name);
  });

  it('accepts a well-formed ChunkSummaryContent payload', () => {
    expect(chunkSummaryContentOutput.parse(VALID_CHUNK)).toEqual(VALID_CHUNK);
  });

  it('has no `unanswered` field — that is a reduce/single-shot-only concept', () => {
    const schema = chunkSummaryContentOutput.jsonSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('unanswered');
  });

  it('rejects a payload missing a required field', () => {
    const { tone: _tone, ...withoutTone } = VALID_CHUNK as Record<string, unknown>;
    expect(() => chunkSummaryContentOutput.parse(withoutTone)).toThrow();
  });
});

describe('the two Zod schemas back the two OutputContracts exactly', () => {
  it('answerContentSchema parses the same as answerContentOutput.parse', () => {
    expect(answerContentSchema.parse(VALID_ANSWER)).toEqual(answerContentOutput.parse(VALID_ANSWER));
  });

  it('chunkSummaryContentSchema parses the same as chunkSummaryContentOutput.parse', () => {
    expect(chunkSummaryContentSchema.parse(VALID_CHUNK)).toEqual(
      chunkSummaryContentOutput.parse(VALID_CHUNK),
    );
  });
});
