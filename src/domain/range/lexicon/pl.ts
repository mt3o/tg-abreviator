/**
 * Polish named-window phrases (DESIGN §2).
 */
import type { RangeLexicon } from './types.js';

export const PL_LEXICON: RangeLexicon = Object.freeze({
  language: 'pl',
  phrases: [
    { phrase: 'w ostatnim tygodniu', window: 'lastWeek' },
    { phrase: 'w zeszlym tygodniu', window: 'lastWeek' },
    { phrase: 'w zeszłym tygodniu', window: 'lastWeek' },
    { phrase: 'w tym tygodniu', window: 'thisWeek' },
    { phrase: 'w zeszlym miesiacu', window: 'lastMonth' },
    { phrase: 'w zeszłym miesiącu', window: 'lastMonth' },
    { phrase: 'w tym miesiacu', window: 'thisMonth' },
    { phrase: 'w tym miesiącu', window: 'thisMonth' },
    { phrase: 'wczoraj', window: 'yesterday' },
    { phrase: 'dzisiaj', window: 'today' },
    { phrase: 'dzis', window: 'today' },
    { phrase: 'dziś', window: 'today' },
  ],
} as const satisfies RangeLexicon);
