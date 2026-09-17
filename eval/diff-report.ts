/**
 * Renders a readable line diff between two runs of the same fixture (DESIGN
 * §12: "output diff against the previous `prompt_version`"). Built on the
 * `diff` package, already a project dependency for exactly this.
 */
import { diffLines } from 'diff';

/** `+`/`-`/` ` prefixed lines, `diff`-style. `previousText === currentText` short-circuits to a fixed marker. */
export function formatDiff(previousText: string, currentText: string): string {
  if (previousText === currentText) return '(no change)';

  const changes = diffLines(previousText, currentText);
  const lines: string[] = [];
  for (const change of changes) {
    const marker = change.added ? '+' : change.removed ? '-' : ' ';
    const segments = change.value.split('\n');
    // `diffLines` values keep their trailing newline; splitting on '\n' turns
    // that into a spurious trailing '' entry.
    if (segments.at(-1) === '') segments.pop();
    for (const line of segments) lines.push(`${marker} ${line}`);
  }
  return lines.join('\n');
}
