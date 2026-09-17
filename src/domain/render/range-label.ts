/**
 * Human-readable range and count labels for the header (DESIGN §2: "Every
 * answer carries a header stating the resolved scope: `Topic: Deploys ·
 * last 2h · 43 messages`. A wrong guess must be visible.").
 *
 * Reads `RangeSpec` (what the user typed), never `ResolvedRange` — the
 * dedupe key is keyed on the raw token for the same reason (DESIGN §9), and
 * for the header it means what is shown is what the user asked for, worded
 * back deterministically rather than re-derived from the resolved window.
 */
import type { DurationUnit, NamedWindow, RangeSpec } from '../model/range.js';
import type { RenderLanguage } from './language.js';

const DURATION_UNIT_SUFFIX: Readonly<Record<DurationUnit, string>> = {
  minutes: 'm',
  hours: 'h',
  days: 'd',
  weeks: 'w',
};

const NAMED_WINDOW_LABEL: Readonly<Record<RenderLanguage, Readonly<Record<NamedWindow, string>>>> = {
  pl: {
    today: 'dzisiaj',
    yesterday: 'wczoraj',
    thisWeek: 'w tym tygodniu',
    lastWeek: 'w ostatnim tygodniu',
    thisMonth: 'w tym miesiącu',
    lastMonth: 'w ostatnim miesiącu',
  },
  en: {
    today: 'today',
    yesterday: 'yesterday',
    thisWeek: 'this week',
    lastWeek: 'last week',
    thisMonth: 'this month',
    lastMonth: 'last month',
  },
};

/** DESIGN §2: the resolved-scope header describing what range was used. */
export function describeRange(spec: RangeSpec, language: RenderLanguage): string {
  switch (spec.kind) {
    case 'messageCount': {
      const count = String(spec.count);
      return language === 'pl' ? `ostatnie ${count}` : `last ${count}`;
    }
    case 'duration': {
      const amount = `${String(spec.duration.amount)}${DURATION_UNIT_SUFFIX[spec.duration.unit]}`;
      return language === 'pl' ? `ostatnie ${amount}` : `last ${amount}`;
    }
    case 'sinceDate':
      return language === 'pl' ? `od ${spec.date.toString()}` : `since ${spec.date.toString()}`;
    case 'namedWindow':
      return NAMED_WINDOW_LABEL[language][spec.window];
    case 'replyAnchor':
      return language === 'pl' ? 'od odpowiedzi' : 'since reply';
    case 'default':
      return language === 'pl' ? 'domyślny zakres' : 'default range';
  }
}

/**
 * Polish plural for "message" collapses to two forms, not three: "wiadomość"
 * for exactly 1, "wiadomości" for every other count (2-4 *and* 5+ share a
 * spelling here, unlike most Polish nouns) — so no genitive-plural branch is
 * needed, just singular vs. everything else.
 */
export function describeMessageCount(count: number, language: RenderLanguage): string {
  if (language === 'pl') {
    return `${String(count)} ${count === 1 ? 'wiadomość' : 'wiadomości'}`;
  }
  return `${String(count)} ${count === 1 ? 'message' : 'messages'}`;
}
