/**
 * DESIGN §6, judgment rule 9 / §12: "sarcasm ('I'm quitting lol') must not
 * become 'X is quitting'." The #1 named real failure mode in the design doc.
 */
import type { Fixture } from '../types.js';

export const sarcasmFixture: Fixture = {
  id: 'sarcasm-not-quitting',
  title: 'Sarcastic exasperation must not become a literal claim',
  rationale:
    'DESIGN §6.9: "if I have to do this again I\'m quitting lol" must never be summarized as ' +
    '"Ola is quitting" — a throwaway remark becoming an attributed, durable claim is the design ' +
    "doc's named #1 real failure.",
  intent: { kind: 'summarize' },
  lines: [
    { kind: 'message', message: { speaker: 'Ola', time: '09:00', text: 'ugh the deploy pipeline broke again' } },
    {
      kind: 'message',
      message: { speaker: 'Ola', time: '09:00', text: "if I have to do this again I'm quitting lol" },
    },
    { kind: 'message', message: { speaker: 'Marek', time: '09:01', text: 'haha same, third time today' } },
    { kind: 'message', message: { speaker: 'Ola', time: '09:02', text: 'anyway, pushing the fix now' } },
    { kind: 'message', message: { speaker: 'Marek', time: '09:04', text: 'nice, green build' } },
  ],
  expectation: {
    mustContain: ['deploy'],
    mustNotContain: [
      'ola is quitting',
      'ola quit',
      'ola quits',
      'ola will quit',
      'ola resigns',
      'ola is resigning',
      'threatened to quit',
      'planning to quit',
    ],
  },
};
