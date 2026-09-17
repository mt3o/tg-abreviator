/**
 * DESIGN §12: "a retracted message." §6.12: "Never carry forward retracted
 * content. Deletions are invisible, but 'sorry, wrong chat' / 'usuńcie to' is
 * not." The message stays in the corpus (there is no delete API), so the
 * model — not the store — is the only thing that can withdraw it.
 */
import type { Fixture } from '../types.js';

export const retractedMessageFixture: Fixture = {
  id: 'retracted-message',
  title: 'A retraction must withdraw the claim from the summary, not just get noted',
  rationale:
    'DESIGN §6.12: a self-retraction ("sorry, wrong chat", "usuńcie to", "ignore that") must not be ' +
    'carried forward as a fact in the summary, even though the transcript itself still shows it — there ' +
    'is no delete API, so this is the only place the retraction can actually take effect.',
  intent: { kind: 'summarize' },
  lines: [
    {
      kind: 'message',
      message: { speaker: 'Kasia', time: '11:00', text: 'reminder: the client meeting is moved to 3pm tomorrow' },
    },
    { kind: 'message', message: { speaker: 'Kasia', time: '11:01', text: 'sorry, wrong chat — ignore that' } },
    { kind: 'message', message: { speaker: 'Tomek', time: '11:02', text: 'no worries :)' } },
    { kind: 'message', message: { speaker: 'Ola', time: '11:05', text: 'anyway, standup is at 10 as usual' } },
  ],
  expectation: {
    mustContain: ['standup'],
    mustNotContain: ['moved to 3pm', 'meeting is moved', 'client meeting is at 3pm', '3pm tomorrow'],
  },
};
