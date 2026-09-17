import { describe, expect, it } from 'vitest';

import { formatDiff } from './diff-report.js';

describe('formatDiff', () => {
  it('returns a fixed marker when nothing changed', () => {
    expect(formatDiff('same\ntext', 'same\ntext')).toBe('(no change)');
  });

  it('marks unchanged lines with a leading space', () => {
    expect(formatDiff('a\nb\nc', 'a\nb\nc\nd')).toContain(' a');
  });

  it('marks added lines with +', () => {
    const diff = formatDiff('a', 'a\nb');
    expect(diff).toContain('+ b');
  });

  it('marks removed lines with -', () => {
    const diff = formatDiff('a\nb', 'a');
    expect(diff).toContain('- b');
  });

  it('shows both additions and removals for a changed line', () => {
    const diff = formatDiff('the meeting is at 3pm', 'the meeting is at 5pm');
    expect(diff).toContain('- the meeting is at 3pm');
    expect(diff).toContain('+ the meeting is at 5pm');
  });
});
