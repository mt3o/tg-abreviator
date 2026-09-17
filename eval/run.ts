#!/usr/bin/env node
/**
 * `npm run eval` (package.json: `tsx eval/run.ts`). WS13's DoD: "`npm run
 * eval` produces a readable per-fixture diff."
 *
 * This is the one place `eval/**` actually calls a real model — everywhere
 * else in this directory only ever sees the `Llm` port (`runner.ts`) or a
 * `FakeLlm` (the test files). Wiring the real `AnthropicLlm` here, rather
 * than behind an indirection, is deliberate: an eval harness whose default
 * run does not call the real provider is not evaluating anything.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { fixtures } from './fixtures/index.js';
import { buildEvalLlm, EVAL_API_KEY_ENV, EVAL_MAX_OUTPUT_TOKENS, EVAL_MODEL_ID } from './llm-client.js';
import { formatReport } from './report.js';
import { runAll } from './runner.js';
import { PROMPT_VERSION } from '../src/application/prompts/system-prompt.js';

const BASELINE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'baselines');

export async function main(): Promise<number> {
  const llm = buildEvalLlm();
  if (llm === null) {
    console.error(
      [
        `eval: ${EVAL_API_KEY_ENV} is not set, so there is no model to evaluate against.`,
        'Set it (see .env.example) and re-run `npm run eval`.',
      ].join('\n'),
    );
    return 1;
  }

  if (fixtures.length === 0) {
    console.error('eval: no fixtures to run (eval/fixtures/index.ts is empty).');
    return 1;
  }

  console.log(`eval: running ${String(fixtures.length)} fixture(s) against ${EVAL_MODEL_ID} (prompt_version ${PROMPT_VERSION})…`);

  const report = await runAll(fixtures, {
    llm,
    model: EVAL_MODEL_ID,
    maxOutputTokens: EVAL_MAX_OUTPUT_TOKENS,
    baselineDir: BASELINE_DIR,
    promptVersion: PROMPT_VERSION,
  });

  console.log(formatReport(report));
  return report.allPassed ? 0 : 1;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error('eval: unexpected failure');
      console.error(error);
      process.exitCode = 1;
    });
}
