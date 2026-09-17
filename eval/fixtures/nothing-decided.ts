/**
 * DESIGN §12: "a thread where nothing was decided (does it say so, or invent
 * one?)." §6.13: "Never assert absence as fact. 'I don't see a decision in
 * this range' — not 'nobody decided anything.'"
 */
import type { Fixture } from '../types.js';

export const nothingDecidedFixture: Fixture = {
  id: 'nothing-decided',
  title: 'An undecided thread must be reported as undecided, not resolved',
  rationale:
    'DESIGN §6.13: when the transcript ends without a decision, the summary must say the range does not ' +
    'show one — hedged, about this range specifically — rather than inventing a resolution or flatly ' +
    'asserting "nobody decided anything" as a settled fact about the whole conversation.',
  intent: { kind: 'summarize' },
  lines: [
    { kind: 'message', message: { speaker: 'Marek', time: '16:00', text: 'should we go with option A or option B?' } },
    { kind: 'message', message: { speaker: 'Ola', time: '16:01', text: "I lean towards A but I'm not sure" } },
    { kind: 'message', message: { speaker: 'Tomek', time: '16:02', text: 'B has better performance though' } },
    { kind: 'message', message: { speaker: 'Ola', time: '16:03', text: 'true, hard call' } },
    { kind: 'message', message: { speaker: 'Marek', time: '16:04', text: "let's revisit tomorrow, gotta run" } },
  ],
  expectation: {
    mustContainAny: [
      'no decision',
      'not decided',
      'undecided',
      'no consensus',
      "haven't decided",
      'has not been decided',
      'unresolved',
      'no clear decision',
    ],
    mustNotContain: [
      'they decided to go with option a',
      'they decided to go with option b',
      'the team chose option a',
      'the team chose option b',
      'decision was made to use option',
      'agreed on option a',
      'agreed on option b',
      'settled on option',
    ],
  },
};
