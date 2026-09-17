/**
 * Structured output contracts (DESIGN §6.7, §7, WS4).
 *
 * "Structured output (`output_config.format`) with fixed fields, so there is no
 * free-text channel for 'output this instead' and no way to leak the system
 * prompt." These are the fixed fields: `AnswerContent` (reduce / single-shot)
 * and `ChunkSummaryContent` (map phase), both frozen domain types
 * (`src/domain/model/answer.ts`). This module only supplies the JSON Schema and
 * the parser the `Llm` port's `OutputContract<T>` asks for; it does not
 * redefine the shape.
 *
 * `parse` deliberately throws Zod's own error on a mismatch rather than
 * `LlmInvalidResponseError` itself — that wrapping is the `Llm` implementation's
 * job (both `FakeLlm` and `AnthropicLlm` do it identically), so a caller
 * comparing the two never sees a difference in *where* the wrap happens.
 */
import { z } from 'zod';

import { TONES } from '../../domain/model/answer.js';
import type { AnswerContent, ChunkSummaryContent } from '../../domain/model/answer.js';
import type { JsonSchemaObject, OutputContract } from '../ports/driven/llm.js';

/** `z.enum` needs a non-empty tuple; `TONES` is `readonly Tone[]`, so this asserts that shape once, here. */
const toneTuple = TONES as unknown as readonly [(typeof TONES)[number], ...(typeof TONES)[number][]];

const toneSchema = z.enum(toneTuple);

const nonEmptyString = z.string().min(1, 'must not be empty');

export const answerContentSchema = z
  .object({
    summary: nonEmptyString,
    keyPoints: z.array(nonEmptyString),
    unanswered: z.array(nonEmptyString),
    tone: toneSchema,
  })
  .strict();

export const chunkSummaryContentSchema = z
  .object({
    summary: nonEmptyString,
    keyPoints: z.array(nonEmptyString),
    tone: toneSchema,
  })
  .strict();

/** Reduce-phase and single-shot calls ask for this. */
export const answerContentOutput: OutputContract<AnswerContent> = {
  name: 'answer_content',
  jsonSchema: z.toJSONSchema(answerContentSchema) as JsonSchemaObject,
  parse: (raw: unknown): AnswerContent => answerContentSchema.parse(raw),
};

/** Map-phase calls (one bucket, compacted) ask for this. */
export const chunkSummaryContentOutput: OutputContract<ChunkSummaryContent> = {
  name: 'chunk_summary_content',
  jsonSchema: z.toJSONSchema(chunkSummaryContentSchema) as JsonSchemaObject,
  parse: (raw: unknown): ChunkSummaryContent => chunkSummaryContentSchema.parse(raw),
};
