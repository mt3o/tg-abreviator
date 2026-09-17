/**
 * English named-window phrases (DESIGN §2).
 */
import type { RangeLexicon } from './types.js';

export const EN_LEXICON: RangeLexicon = Object.freeze({
  language: 'en',
  phrases: [
    { phrase: 'last week', window: 'lastWeek' },
    { phrase: 'this week', window: 'thisWeek' },
    { phrase: 'last month', window: 'lastMonth' },
    { phrase: 'this month', window: 'thisMonth' },
    { phrase: 'yesterday', window: 'yesterday' },
    { phrase: 'today', window: 'today' },
  ],
} as const satisfies RangeLexicon);
