/**
 * Renders a fixture's lines into the transcript text the model sees, matching
 * DESIGN §3's corpus format ("formatting as `[HH:MM] Name: text`") and §4's
 * gap-marker disclosure. Deliberately independent of
 * `src/domain/corpus/assemble.ts` (WS10's, not this workstream's dependency —
 * see docs/PLAN.md, WS13 "Depends on: WS4" only): fixtures are hand-written
 * strings, not `StoredMessage` rows, so there is nothing to assemble from a
 * store here.
 */
import type { FixtureLine } from './types.js';

function renderLine(line: FixtureLine): string {
  if (line.kind === 'gap') return `--- gap: ${line.note} ---`;
  return `[${line.message.time}] ${line.message.speaker}: ${line.message.text}`;
}

export function buildTranscript(lines: readonly FixtureLine[]): string {
  return lines.map(renderLine).join('\n');
}
