/**
 * Persists one run's output per fixture, keyed by `prompt_version`, so the
 * next run of `npm run eval` can diff "what the model says now" against "what
 * it said the last time this fixture ran under a different prompt" (DESIGN
 * §12: "output diff against the previous `prompt_version`").
 *
 * One JSON file per fixture, at `<baselineDir>/<fixtureId>.json`. A file holds
 * at most one entry per `promptVersion` — a re-run under the same version
 * overwrites that version's entry rather than growing forever, so the file
 * only ever has as many entries as there are prompt versions this fixture has
 * actually been run under.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AnswerContent } from '../src/domain/model/answer.js';

export interface BaselineEntry {
  readonly promptVersion: string;
  readonly model: string;
  readonly content: AnswerContent;
  /** ISO instant string. Informational only — never used to order entries (see module docs). */
  readonly recordedAt: string;
}

export interface BaselineFile {
  readonly fixtureId: string;
  /** Insertion order is significant: it is how `previousEntry` finds "the run before this one". */
  readonly entries: readonly BaselineEntry[];
}

function emptyFile(fixtureId: string): BaselineFile {
  return { fixtureId, entries: [] };
}

function baselinePath(baselineDir: string, fixtureId: string): string {
  return join(baselineDir, `${fixtureId}.json`);
}

export async function readBaselineFile(baselineDir: string, fixtureId: string): Promise<BaselineFile> {
  try {
    const raw = await readFile(baselinePath(baselineDir, fixtureId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isBaselineFile(parsed) ? parsed : emptyFile(fixtureId);
  } catch (error) {
    if (isNotFound(error)) return emptyFile(fixtureId);
    throw error;
  }
}

export async function writeBaselineFile(baselineDir: string, file: BaselineFile): Promise<void> {
  await mkdir(baselineDir, { recursive: true });
  await writeFile(baselinePath(baselineDir, file.fixtureId), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * Replaces the entry for `entry.promptVersion` if one exists, otherwise
 * appends. Returns a new `BaselineFile` — the input is never mutated.
 */
export function upsertEntry(file: BaselineFile, entry: BaselineEntry): BaselineFile {
  const withoutSameVersion = file.entries.filter((existing) => existing.promptVersion !== entry.promptVersion);
  return { fixtureId: file.fixtureId, entries: [...withoutSameVersion, entry] };
}

/**
 * The most recently recorded entry whose `promptVersion` differs from
 * `currentPromptVersion` — "the previous prompt_version" DESIGN §12 asks the
 * harness to diff against. `null` when the fixture has never run under a
 * different version (including: never run at all).
 */
export function previousEntry(file: BaselineFile, currentPromptVersion: string): BaselineEntry | null {
  const others = file.entries.filter((entry) => entry.promptVersion !== currentPromptVersion);
  return others.at(-1) ?? null;
}

function isBaselineFile(value: unknown): value is BaselineFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['fixtureId'] === 'string' && Array.isArray(candidate['entries']);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
