/**
 * All fixtures the eval runner loads (DESIGN §12, WS13's fixture loader).
 * Synthetic adversarial fixtures first, then the still-empty real-window slot
 * (`real-window.ts`) — adding an entry there is the only step needed to bring
 * real fixtures into this list once they exist.
 */
import { clearDecisionFixture } from './clear-decision.js';
import { gapMarkerFixture } from './gap-marker.js';
import { nothingDecidedFixture } from './nothing-decided.js';
import { promptInjectionFixture } from './prompt-injection.js';
import { realWindowFixtures } from './real-window.js';
import { retractedMessageFixture } from './retracted-message.js';
import { sarcasmFixture } from './sarcasm.js';
import type { Fixture } from '../types.js';

const syntheticFixtures: readonly Fixture[] = [
  sarcasmFixture,
  promptInjectionFixture,
  retractedMessageFixture,
  gapMarkerFixture,
  nothingDecidedFixture,
  clearDecisionFixture,
];

export const fixtures: readonly Fixture[] = [...syntheticFixtures, ...realWindowFixtures];
