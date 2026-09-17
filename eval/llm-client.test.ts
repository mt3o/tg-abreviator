import { describe, expect, it } from 'vitest';

import { buildEvalLlm, EVAL_API_KEY_ENV, EVAL_MODEL_ID, evalModelRegistry } from './llm-client.js';
import type { AnthropicClientFactory, AnthropicClientLike } from '../src/adapters/outbound/anthropic/client.js';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';

function fixtureMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_test',
    container: null,
    content: [{ type: 'text', text: '{"summary":"s","keyPoints":[],"unanswered":[],"tone":"neutral"}', citations: null }],
    model: EVAL_MODEL_ID,
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
    ...overrides,
  };
}

describe('evalModelRegistry', () => {
  it('exposes exactly one entry, keyed by ANTHROPIC_API_KEY, matching config.example.yaml\'s sonnet alias', () => {
    const registry = evalModelRegistry();
    expect(Object.keys(registry)).toEqual(['sonnet']);
    expect(registry['sonnet']).toEqual({
      provider: 'anthropic',
      model: EVAL_MODEL_ID,
      apiKeyEnv: EVAL_API_KEY_ENV,
      maxOutputTokens: 4096,
    });
  });
});

describe('buildEvalLlm', () => {
  it('returns null when the API key env var is unset', () => {
    expect(buildEvalLlm({ env: {} })).toBeNull();
  });

  it('returns null when the API key env var is set but empty', () => {
    expect(buildEvalLlm({ env: { [EVAL_API_KEY_ENV]: '' } })).toBeNull();
  });

  it('returns a working Llm, authenticated from the configured env var, when the key is present', async () => {
    const calls: { apiKey: string; params: MessageCreateParamsNonStreaming }[] = [];
    const clientFactory: AnthropicClientFactory = (apiKey) => {
      const client: AnthropicClientLike = {
        messages: {
          create: async (params) => {
            calls.push({ apiKey, params });
            return await Promise.resolve(fixtureMessage());
          },
          countTokens: () => {
            throw new Error('not exercised in this test');
          },
        },
      };
      return client;
    };

    const llm = buildEvalLlm({ env: { [EVAL_API_KEY_ENV]: 'sk-test-key' }, clientFactory });
    expect(llm).not.toBeNull();

    const response = await llm?.complete({
      model: EVAL_MODEL_ID,
      system: 'system prompt',
      userBlocks: [{ kind: 'transcript', text: 't' }],
      output: {
        name: 'answer_content',
        jsonSchema: {},
        parse: (raw) => raw as { summary: string },
      },
      maxOutputTokens: 4096,
      phase: 'single',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.apiKey).toBe('sk-test-key');
    expect(response?.structured).toEqual({ summary: 's', keyPoints: [], unanswered: [], tone: 'neutral' });
  });
});
