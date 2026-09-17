import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVAL_API_KEY_ENV } from './llm-client.js';
import { main } from './run.js';

describe('main', () => {
  let originalKey: string | undefined;
  let errorMessages: string[] = [];

  beforeEach(() => {
    originalKey = process.env[EVAL_API_KEY_ENV];
    errorMessages = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorMessages.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env[EVAL_API_KEY_ENV];
    } else {
      process.env[EVAL_API_KEY_ENV] = originalKey;
    }
    vi.restoreAllMocks();
  });

  it('exits with a readable message instead of throwing when no API key is configured', async () => {
    delete process.env[EVAL_API_KEY_ENV];

    const exitCode = await main();

    expect(exitCode).toBe(1);
    expect(errorMessages.join(' ')).toContain(EVAL_API_KEY_ENV);
  });
});
