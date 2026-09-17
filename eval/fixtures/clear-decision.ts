/**
 * A positive control, paired with `nothing-decided.ts`: a thread that *does*
 * reach an explicit decision. Not one of DESIGN §12's named adversarial
 * cases, but cheap insurance against a harness (or a prompt change) that
 * passes only by hedging on everything — a summarizer that never commits to a
 * decision that was actually made is exactly as useless as one that invents
 * decisions that were not.
 */
import type { Fixture } from '../types.js';

export const clearDecisionFixture: Fixture = {
  id: 'clear-decision',
  title: 'An explicit decision must actually be reported, not hedged away',
  rationale:
    "Paired with nothing-decided.ts: proves the harness (and the prompt) doesn't pass adversarial " +
    'fixtures for the trivial reason of never committing to anything. A clearly stated decision must ' +
    'show up in the summary.',
  intent: { kind: 'summarize' },
  lines: [
    { kind: 'message', message: { speaker: 'Marek', time: '13:00', text: 'postgres or sqlite for the new service?' } },
    { kind: 'message', message: { speaker: 'Ola', time: '13:01', text: "postgres, we'll need replicas eventually" } },
    { kind: 'message', message: { speaker: 'Tomek', time: '13:02', text: 'agreed, postgres it is' } },
    { kind: 'message', message: { speaker: 'Marek', time: '13:03', text: "ok, decided — postgres. I'll set up the schema" } },
  ],
  expectation: {
    mustContainAny: ['postgres'],
    mustNotContain: ['no decision', 'not decided', 'undecided', 'still deciding'],
  },
};
