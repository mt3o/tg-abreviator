/**
 * Integration test for the full rendering pipeline (DESIGN §6.5, §6.6, §6.8,
 * §2, §4, §9) plus the WS5 DoD fuzz requirement applied end-to-end.
 */
import { describe, expect, it } from 'vitest';

import { Temporal } from '../time/temporal.js';
import { asChatId, asThreadId } from '../model/ids.js';
import type { RangeSpec, ResolvedRange } from '../model/range.js';
import { threadScope } from '../model/scope.js';
import type { Answer, AnswerContent, AnswerMeta, Tone } from '../model/answer.js';
import { ALLOWED_TAGS } from './html.js';
import { renderAnswer } from './render-answer.js';
import type { RenderOptions } from './render-answer.js';
import type { SlurWordlist } from './slurs.js';

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

const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const NO_SLURS: SlurWordlist = { pl: [], en: [] };

function resolvedRange(spec: RangeSpec): ResolvedRange {
  return {
    scope: threadScope(null),
    start: { kind: 'instant', ts: NOW.subtract({ hours: 2 }) },
    end: NOW,
    limit: 500,
    spec,
    basis: 'explicit',
    clampedToHorizon: false,
    timeZone: 'Europe/Warsaw',
  };
}

function baseAnswer(overrides: {
  content?: Partial<AnswerContent>;
  meta?: Partial<AnswerMeta>;
}): Answer {
  const spec: RangeSpec = { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } };
  const content: AnswerContent = {
    summary: 'The team decided to ship on Friday.',
    keyPoints: ['Ship on Friday', 'Ola will write the release notes'],
    unanswered: ['Who is on call over the weekend?'],
    tone: 'neutral',
    ...overrides.content,
  };
  const meta: AnswerMeta = {
    chatId: asChatId(-1001),
    scope: threadScope(asThreadId(7)),
    topicLabel: 'Deploys',
    range: resolvedRange(spec),
    spec,
    messageCount: 43,
    gapCount: 0,
    cached: null,
    model: 'claude-sonnet-5',
    promptVersion: 'v1',
    ...overrides.meta,
  };
  return { content, meta };
}

const OPTIONS: RenderOptions = { language: 'en', slurWordlist: NO_SLURS };

describe('renderAnswer — happy path', () => {
  it('produces a single well-formed part carrying header, body and footer', () => {
    const parts = renderAnswer(baseAnswer({}), OPTIONS);
    expect(parts.length).toBe(1);
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(isWellFormed(part)).toBe(true);
    expect(part).toContain('Topic: Deploys · last 2h · 43 messages');
    expect(part).toContain('The team decided to ship on Friday.');
    expect(part).toContain('Key points');
    expect(part).toContain('Ship on Friday');
    expect(part).toContain('Unanswered');
    expect(part).toContain('Who is on call over the weekend?');
    expect(part).toContain('🤖 AI summary — may be wrong');
  });

  it('omits empty sections rather than printing an empty heading', () => {
    const parts = renderAnswer(baseAnswer({ content: { keyPoints: [], unanswered: [] } }), OPTIONS);
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(part).not.toContain('Key points');
    expect(part).not.toContain('Unanswered');
  });

  it('renders Polish labels when language is pl', () => {
    const parts = renderAnswer(baseAnswer({}), { ...OPTIONS, language: 'pl' });
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(part).toContain('Kluczowe punkty');
    expect(part).toContain('Bez odpowiedzi');
    expect(part).toContain('🤖 Podsumowanie AI — może się mylić');
  });
});

describe('renderAnswer — safety rules applied to model output', () => {
  it('substitutes a configured slur in the summary', () => {
    const wordlist: SlurWordlist = { pl: [], en: ['damn'] };
    const parts = renderAnswer(
      baseAnswer({ content: { summary: 'well, damn, that escalated' } }),
      { ...OPTIONS, slurWordlist: wordlist },
    );
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(part).not.toContain('damn');
    expect(part).toContain('d***');
  });

  it('strips a tg:// link and neutralises a mention inside a key point', () => {
    const parts = renderAnswer(
      baseAnswer({
        content: { keyPoints: ['see tg://resolve?domain=x and ping @everyone'] },
      }),
      OPTIONS,
    );
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(part).not.toContain('tg://');
    expect(part).not.toContain('@everyone'); // the raw, still-mentionable form
    expect(part).toContain('@​everyone');
  });

  it('reduces a disallowed tag in the summary to escaped text', () => {
    const parts = renderAnswer(
      baseAnswer({ content: { summary: '<script>alert(1)</script> plain text' } }),
      OPTIONS,
    );
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(part).not.toContain('<script>');
    expect(isWellFormed(part)).toBe(true);
  });

  it('adds a ⚠️ to the header for a heated tone', () => {
    const parts = renderAnswer(baseAnswer({ content: { tone: 'heated' } }), OPTIONS);
    const [part] = parts;
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(part).toContain('⚠️');
  });
});

describe('renderAnswer — WS5 DoD: hostile model output, end to end', () => {
  const tones: readonly Tone[] = ['neutral', 'heated', 'playful', 'technical', 'mixed'];

  const hostileSummaries: readonly string[] = [
    '<b>unbalanced start',
    '</b><i>stray close</code>',
    'tg://resolve?domain=evil.example and tg://openmessage?chat_id=1',
    '@everyone @here @admin '.repeat(200),
    'x'.repeat(20_000),
    '<script>document.location="evil"</script>'.repeat(200),
    '<b>'.repeat(2000) + 'content'.repeat(2000) + '</i>'.repeat(2000),
  ];

  it.each(hostileSummaries.map((summary, index) => [index, summary] as const))(
    'hostile case %i always yields well-formed parts, each ≤4096 chars, ≤3 parts',
    (_index, summary) => {
      const answer = baseAnswer({
        content: {
          summary,
          keyPoints: [summary, '@mention tg://x'],
          unanswered: ['<b>open</b> ' + summary.slice(0, 500)],
          tone: tones[_index % tones.length],
        },
        meta: { gapCount: 2, cached: { ageMinutes: 1 } },
      });
      const parts = renderAnswer(answer, OPTIONS);
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.length).toBeLessThanOrEqual(3);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(4096);
        expect(isWellFormed(part)).toBe(true);
      }
    },
  );

  it('never throws for any hostile case', () => {
    for (const summary of hostileSummaries) {
      expect(() => renderAnswer(baseAnswer({ content: { summary } }), OPTIONS)).not.toThrow();
    }
  });
});
