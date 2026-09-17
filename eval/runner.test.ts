import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeLlm } from '../test/fakes/fake-llm.js';
import { answerText, runAll, runFixture } from './runner.js';
import type { AnswerContent } from '../src/domain/model/answer.js';
import type { Fixture } from './types.js';

const SUMMARIZE_FIXTURE: Fixture = {
  id: 'test-summarize',
  title: 'test',
  rationale: 'test',
  intent: { kind: 'summarize' },
  lines: [{ kind: 'message', message: { speaker: 'Ola', time: '09:00', text: 'the deploy is done' } }],
  expectation: { mustContain: ['deploy'], mustNotContain: ['rollback'] },
};

const ANSWER_FIXTURE: Fixture = {
  id: 'test-answer',
  title: 'test',
  rationale: 'test',
  intent: { kind: 'answer', question: 'is the deploy done?' },
  lines: [{ kind: 'message', message: { speaker: 'Ola', time: '09:00', text: 'yes, deploy is done' } }],
  expectation: { mustContain: ['yes'] },
};

function content(overrides: Partial<AnswerContent> = {}): AnswerContent {
  return { summary: 'the deploy is done', keyPoints: [], unanswered: [], tone: 'neutral', ...overrides };
}

describe('runFixture', () => {
  it('sends the transcript as a user block and the intent-appropriate system prompt', async () => {
    const llm = new FakeLlm();
    llm.enqueue({ raw: content() });

    const result = await runFixture(SUMMARIZE_FIXTURE, {
      llm,
      model: 'claude-sonnet-5',
      maxOutputTokens: 1024,
      promptVersion: 'v-test',
    });

    expect(result.content).toEqual(content());
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.promptVersion).toBe('v-test');

    const request = llm.requests[0];
    expect(request?.userBlocks.some((block) => block.kind === 'transcript' && block.text.includes('the deploy is done'))).toBe(
      true,
    );
    expect(request?.userBlocks.some((block) => block.kind === 'question')).toBe(false);
  });

  it('adds a question block for an "answer" fixture, and never puts it in the system prompt', async () => {
    const llm = new FakeLlm();
    llm.enqueue({ raw: content({ summary: 'yes, deploy is done' }) });

    await runFixture(ANSWER_FIXTURE, { llm, model: 'claude-sonnet-5', maxOutputTokens: 1024 });

    const request = llm.requests[0];
    expect(request?.userBlocks.some((block) => block.kind === 'question' && block.text === 'is the deploy done?')).toBe(
      true,
    );
    expect(request?.system.includes('is the deploy done?')).toBe(false);
  });

  it('defaults promptVersion to the real WS4 PROMPT_VERSION when not overridden', async () => {
    const llm = new FakeLlm();
    llm.enqueue({ raw: content() });
    const result = await runFixture(SUMMARIZE_FIXTURE, { llm, model: 'claude-sonnet-5', maxOutputTokens: 1024 });
    expect(result.promptVersion.length).toBeGreaterThan(0);
  });
});

describe('answerText', () => {
  it('joins summary, keyPoints and unanswered', () => {
    const text = answerText(content({ summary: 's', keyPoints: ['a', 'b'], unanswered: ['u'] }));
    expect(text).toBe('s\na\nb\nu');
  });
});

describe('runAll', () => {
  let baselineDir = '';

  beforeEach(async () => {
    baselineDir = await mkdtemp(join(tmpdir(), 'eval-runner-'));
  });

  afterEach(async () => {
    await rm(baselineDir, { recursive: true, force: true });
  });

  it('reports pass/fail per fixture and an overall allPassed', async () => {
    const llm = new FakeLlm();
    llm.enqueue({ raw: content({ summary: 'the deploy is done' }) }); // matches SUMMARIZE_FIXTURE
    llm.enqueue({ raw: content({ summary: 'no, sorry' }) }); // fails ANSWER_FIXTURE's mustContain: ['yes']

    const report = await runAll([SUMMARIZE_FIXTURE, ANSWER_FIXTURE], {
      llm,
      model: 'claude-sonnet-5',
      maxOutputTokens: 1024,
      baselineDir,
      promptVersion: 'v1',
    });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]?.check.pass).toBe(true);
    expect(report.rows[1]?.check.pass).toBe(false);
    expect(report.allPassed).toBe(false);
  });

  it('marks the first run of a fixture as "(first run)" with no previous baseline', async () => {
    const llm = new FakeLlm();
    llm.enqueue({ raw: content() });

    const report = await runAll([SUMMARIZE_FIXTURE], {
      llm,
      model: 'claude-sonnet-5',
      maxOutputTokens: 1024,
      baselineDir,
      promptVersion: 'v1',
    });

    expect(report.rows[0]?.previous).toBeNull();
    expect(report.rows[0]?.diff).toBe('(first run)');
  });

  it('diffs against the previous prompt_version on a later run, and (no change) when the text is identical', async () => {
    const runOnce = async (promptVersion: string, summary: string) => {
      const llm = new FakeLlm();
      llm.enqueue({ raw: content({ summary }) });
      return runAll([SUMMARIZE_FIXTURE], {
        llm,
        model: 'claude-sonnet-5',
        maxOutputTokens: 1024,
        baselineDir,
        promptVersion,
      });
    };

    await runOnce('v1', 'the deploy is done');
    const second = await runOnce('v2', 'the deploy finished successfully');

    expect(second.rows[0]?.previous).toEqual({ promptVersion: 'v1', text: 'the deploy is done' });
    expect(second.rows[0]?.diff).toContain('- the deploy is done');
    expect(second.rows[0]?.diff).toContain('+ the deploy finished successfully');

    const third = await runOnce('v3', 'the deploy finished successfully');
    expect(third.rows[0]?.diff).toBe('(no change)');
  });

  it('does not re-call the model under the same promptVersion twice in a row without changing the baseline entry count', async () => {
    const runOnce = async () => {
      const llm = new FakeLlm();
      llm.enqueue({ raw: content() });
      return runAll([SUMMARIZE_FIXTURE], {
        llm,
        model: 'claude-sonnet-5',
        maxOutputTokens: 1024,
        baselineDir,
        promptVersion: 'v1',
      });
    };
    await runOnce();
    const report = await runOnce();
    // Same version twice in a row: nothing "previous" to diff against under a *different* version.
    expect(report.rows[0]?.previous).toBeNull();
  });
});
