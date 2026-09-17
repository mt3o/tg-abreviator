import { describe, expect, it } from 'vitest';

import { Temporal } from '../time/temporal.js';
import { asMessageId } from '../model/ids.js';
import type { RangeSpec } from '../model/range.js';
import { describeMessageCount, describeRange } from './range-label.js';

describe('describeRange', () => {
  const cases: readonly [RangeSpec, string, string][] = [
    [{ kind: 'messageCount', raw: '-50', count: 50 }, 'last 50', 'ostatnie 50'],
    [
      { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      'last 2h',
      'ostatnie 2h',
    ],
    [
      { kind: 'duration', raw: '30m', duration: { unit: 'minutes', amount: 30 } },
      'last 30m',
      'ostatnie 30m',
    ],
    [
      { kind: 'sinceDate', raw: '2026-09-15', date: Temporal.PlainDate.from('2026-09-15') },
      'since 2026-09-15',
      'od 2026-09-15',
    ],
    [{ kind: 'namedWindow', raw: 'yesterday', window: 'yesterday' }, 'yesterday', 'wczoraj'],
    [
      { kind: 'namedWindow', raw: 'w ostatnim tygodniu', window: 'lastWeek' },
      'last week',
      'w ostatnim tygodniu',
    ],
    [
      { kind: 'replyAnchor', raw: '', messageId: asMessageId(42) },
      'since reply',
      'od odpowiedzi',
    ],
    [{ kind: 'default', raw: '' }, 'default range', 'domyślny zakres'],
  ];

  it.each(cases)('describes %j correctly in both languages', (spec, en, pl) => {
    expect(describeRange(spec, 'en')).toBe(en);
    expect(describeRange(spec, 'pl')).toBe(pl);
  });
});

describe('describeMessageCount', () => {
  it('uses singular for exactly 1 in both languages', () => {
    expect(describeMessageCount(1, 'en')).toBe('1 message');
    expect(describeMessageCount(1, 'pl')).toBe('1 wiadomość');
  });

  it('uses plural for 0, 2-4 and 5+ alike in Polish', () => {
    expect(describeMessageCount(0, 'pl')).toBe('0 wiadomości');
    expect(describeMessageCount(2, 'pl')).toBe('2 wiadomości');
    expect(describeMessageCount(4, 'pl')).toBe('4 wiadomości');
    expect(describeMessageCount(43, 'pl')).toBe('43 wiadomości');
  });

  it('uses plural for anything other than 1 in English', () => {
    expect(describeMessageCount(0, 'en')).toBe('0 messages');
    expect(describeMessageCount(43, 'en')).toBe('43 messages');
  });
});
