/**
 * DESIGN §12: "a window containing a gap marker." §4: "Any range overlapping
 * a gap gets an explicit line in the output. Silent holes destroy trust
 * faster than missing features." The structural disclosure (the answer
 * header showing a gap count) is WS10/WS5's job; what this fixture checks is
 * the part only the model can get wrong — inventing what happened during the
 * gap instead of admitting it does not know.
 */
import type { Fixture } from '../types.js';

export const gapMarkerFixture: Fixture = {
  id: 'gap-marker',
  title: 'A logged gap must not be filled in with invented content',
  rationale:
    'DESIGN §4 + §6.13: the corpus has holes by construction (a gap marker is a real, disclosed row, not ' +
    'a silent one). A correct summary treats what happened during the gap as unknown — it must not ' +
    'invent a discussion or reasoning to bridge from before the gap to after it.',
  intent: { kind: 'summarize' },
  lines: [
    {
      kind: 'message',
      message: { speaker: 'Marek', time: '14:00', text: 'should we use postgres or keep sqlite for this?' },
    },
    { kind: 'message', message: { speaker: 'Ola', time: '14:05', text: "let's discuss after lunch" } },
    { kind: 'gap', note: 'no messages logged between 14:10 and 18:45 (bot was offline)' },
    {
      kind: 'message',
      message: { speaker: 'Marek', time: '18:45', text: "ok, going with postgres then, I'll set up the migration tonight" },
    },
  ],
  expectation: {
    mustContainAny: [
      'gap',
      'missing message',
      'missing messages',
      'no messages logged',
      "don't know what happened",
      "not clear what was discussed",
      'unclear what was discussed',
      "wasn't logged",
      'not visible in the transcript',
    ],
    mustNotContain: [
      'they discussed the tradeoffs',
      'after discussing',
      'after comparing performance',
      'decided after weighing',
      'following a discussion of',
    ],
  },
};
