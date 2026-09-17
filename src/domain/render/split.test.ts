/**
 * DESIGN §1, §8 + WS5 DoD: "assert the result is always valid Telegram HTML
 * under 4096 chars per part. A split must never land inside a tag."
 */
import { describe, expect, it } from 'vitest';

import { ALLOWED_TAGS, sanitizeToTelegramHtml } from './html.js';
import { splitHtmlIntoParts } from './split.js';

function isWellFormed(html: string): boolean {
  const stack: string[] = [];
  const pattern = new RegExp(`<(/?)(${ALLOWED_TAGS.join('|')})>`, 'g');
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = pattern.exec(html)) !== null) {
    const between = html.slice(lastIndex, match.index);
    if (/[<>]/.test(between)) return false;
    lastIndex = match.index + match[0].length;
    const [, closeFlag, tag] = match;
    if (closeFlag === '/') {
      if (stack.pop() !== tag) return false;
    } else if (tag !== undefined) {
      stack.push(tag);
    }
  }
  if (/[<>]/.test(html.slice(lastIndex))) return false;
  return stack.length === 0;
}

/** No part may cut through the literal characters of a tag. */
function noPartEndsMidTag(parts: readonly string[]): boolean {
  return parts.every((part) => {
    const lastOpen = part.lastIndexOf('<');
    const lastClose = part.lastIndexOf('>');
    return lastOpen <= lastClose; // every '<' in the part is matched by a later '>'
  });
}

describe('splitHtmlIntoParts — short content', () => {
  it('returns a single part when content fits', () => {
    const parts = splitHtmlIntoParts('<b>hello</b> world');
    expect(parts).toEqual(['<b>hello</b> world']);
  });

  it('returns an empty-content single part for an empty string', () => {
    expect(splitHtmlIntoParts('')).toEqual(['']);
  });
});

describe('splitHtmlIntoParts — paragraph-preferring split', () => {
  it('splits on a paragraph boundary when the whole text does not fit', () => {
    const paraA = 'A'.repeat(3000);
    const paraB = 'B'.repeat(3000);
    const html = `${paraA}\n\n${paraB}`;
    const parts = splitHtmlIntoParts(html, { maxChars: 4096, maxParts: 3 });
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(paraA);
    expect(parts[1]).toBe(paraB);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
  });
});

describe('splitHtmlIntoParts — tag safety', () => {
  it('never lands a cut inside a tag literal, across many random-ish sizes', () => {
    for (const size of [10, 100, 4095, 4096, 4097, 5000, 8192, 20_000]) {
      const raw = Array.from({ length: size }, (_, i) =>
        i % 7 === 0 ? '<b>' : i % 7 === 1 ? '</b>' : i % 7 === 2 ? '<i>' : i % 7 === 3 ? '</i>' : 'x',
      ).join('');
      const sanitized = sanitizeToTelegramHtml(raw);
      const parts = splitHtmlIntoParts(sanitized, { maxChars: 200, maxParts: 1000 });
      expect(noPartEndsMidTag(parts)).toBe(true);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(200);
        expect(isWellFormed(part)).toBe(true);
      }
    }
  });

  it('reopens and closes a single tag that spans a forced split', () => {
    const longBold = `<b>${'y'.repeat(500)}</b>`;
    const parts = splitHtmlIntoParts(longBold, { maxChars: 100, maxParts: 100 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(100);
      expect(isWellFormed(part)).toBe(true);
      expect(part.includes('y')).toBe(true);
    }
  });
});

describe('splitHtmlIntoParts — maxParts cap', () => {
  it('never returns more than maxParts parts', () => {
    const html = Array.from({ length: 50 }, (_, i) => `paragraph ${String(i)}`.repeat(50)).join('\n\n');
    const parts = splitHtmlIntoParts(html, { maxChars: 500, maxParts: 3 });
    expect(parts.length).toBeLessThanOrEqual(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
  });

  it('appends the truncation notice to the last kept part when it fits', () => {
    const html = Array.from({ length: 50 }, (_, i) => `paragraph ${String(i)}`.repeat(50)).join('\n\n');
    const parts = splitHtmlIntoParts(html, {
      maxChars: 500,
      maxParts: 2,
      truncationNotice: '\n\n<i>truncated</i>',
    });
    expect(parts.length).toBe(2);
    expect(parts[1]).toContain('truncated');
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(500);
      expect(isWellFormed(part)).toBe(true);
    }
  });

  it('never exceeds maxChars even when a truncation notice would not fit', () => {
    const html = 'z'.repeat(10_000);
    const parts = splitHtmlIntoParts(html, {
      maxChars: 50,
      maxParts: 2,
      truncationNotice: 'x'.repeat(1000), // deliberately too big to fit
    });
    expect(parts.length).toBe(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(50);
  });
});

describe('splitHtmlIntoParts — 20K hostile fuzz (WS5 DoD)', () => {
  const hostileInputs: readonly string[] = [
    '<b>unbalanced'.repeat(2000),
    '</b><i>broken</code>'.repeat(1000),
    ('tg://resolve?x=1 @everyone ' + 'word '.repeat(50)).repeat(120),
    'x'.repeat(20_000),
    '<b>'.repeat(3000) + 'y'.repeat(10_000) + '</i>'.repeat(3000),
  ];

  it.each(hostileInputs.map((input, index) => [index, input] as const))(
    'hostile case %i splits into valid, bounded, tag-safe parts',
    (_index, input) => {
      const sanitized = sanitizeToTelegramHtml(input);
      const parts = splitHtmlIntoParts(sanitized, { maxChars: 4096, maxParts: 3 });
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.length).toBeLessThanOrEqual(3);
      expect(noPartEndsMidTag(parts)).toBe(true);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(4096);
        expect(isWellFormed(part)).toBe(true);
      }
    },
  );
});
