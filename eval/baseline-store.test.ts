import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { previousEntry, readBaselineFile, upsertEntry, writeBaselineFile } from './baseline-store.js';
import type { BaselineEntry, BaselineFile } from './baseline-store.js';
import type { AnswerContent } from '../src/domain/model/answer.js';

const CONTENT: AnswerContent = { summary: 's', keyPoints: [], unanswered: [], tone: 'neutral' };

function entry(promptVersion: string, recordedAt = '2026-01-01T00:00:00.000Z'): BaselineEntry {
  return { promptVersion, model: 'claude-sonnet-5', content: CONTENT, recordedAt };
}

describe('baseline-store', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-baseline-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('readBaselineFile returns an empty file when nothing has been written yet', async () => {
    const file = await readBaselineFile(dir, 'never-run');
    expect(file).toEqual({ fixtureId: 'never-run', entries: [] });
  });

  it('round-trips through writeBaselineFile / readBaselineFile', async () => {
    const written = upsertEntry({ fixtureId: 'sarcasm', entries: [] }, entry('v1'));
    await writeBaselineFile(dir, written);

    const read = await readBaselineFile(dir, 'sarcasm');
    expect(read).toEqual(written);
  });

  it('creates the baseline directory on write if it does not exist yet', async () => {
    const nested = join(dir, 'nested', 'baselines');
    await writeBaselineFile(nested, upsertEntry({ fixtureId: 'x', entries: [] }, entry('v1')));
    const raw = await readFile(join(nested, 'x.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ fixtureId: 'x', entries: [entry('v1')] });
  });

  it('upsertEntry replaces an existing entry for the same promptVersion, keeping others', () => {
    let file: BaselineFile = { fixtureId: 'f', entries: [] };
    file = upsertEntry(file, entry('v1', 'first'));
    file = upsertEntry(file, entry('v2', 'second'));
    file = upsertEntry(file, entry('v1', 'first-rerun'));

    expect(file.entries.map((e) => [e.promptVersion, e.recordedAt])).toEqual([
      ['v2', 'second'],
      ['v1', 'first-rerun'],
    ]);
  });

  it('does not mutate the input file', () => {
    const original = { fixtureId: 'f', entries: [entry('v1')] };
    const frozen = JSON.parse(JSON.stringify(original)) as typeof original;
    upsertEntry(original, entry('v2'));
    expect(original).toEqual(frozen);
  });

  it('previousEntry finds the most recently recorded entry under a different promptVersion', () => {
    let file: BaselineFile = { fixtureId: 'f', entries: [] };
    file = upsertEntry(file, entry('v1'));
    file = upsertEntry(file, entry('v2'));

    expect(previousEntry(file, 'v3')?.promptVersion).toBe('v2');
    expect(previousEntry(file, 'v2')?.promptVersion).toBe('v1');
  });

  it('previousEntry returns null when there is nothing under a different version', () => {
    const file = upsertEntry({ fixtureId: 'f', entries: [] }, entry('v1'));
    expect(previousEntry(file, 'v1')).toBeNull();
    expect(previousEntry({ fixtureId: 'f', entries: [] }, 'v1')).toBeNull();
  });
});
