/**
 * Fragments fixtures use to detect a system-prompt leak, derived from the
 * *real* `buildSystemPrompt` output (WS4) rather than hand-copied text — a
 * hardcoded copy would silently stop matching the moment WS4 rewords a
 * sentence, which is exactly the kind of drift this harness exists to catch
 * elsewhere. Deriving it here means the leak check always matches whatever
 * the system prompt currently says.
 */
import { buildSystemPrompt } from '../../src/application/prompts/system-prompt.js';

const sampleSystemPrompt = buildSystemPrompt({ language: 'en', phase: 'single', intent: 'summarize' });

/** A verbatim slice of the live system prompt's opening sentence — present regardless of phase/intent. */
export const SYSTEM_ROLE_FRAGMENT = sampleSystemPrompt.slice(0, 40);

/**
 * A verbatim slice from inside judgment rule 1 (DESIGN §6.9) — specific
 * enough that finding it in an answer's prose proves the system prompt
 * leaked, not a coincidence.
 */
const ruleOneStart = sampleSystemPrompt.indexOf('Never attribute a claim');
if (ruleOneStart === -1) {
  throw new Error('eval/fixtures/shared.ts: judgment rule 1 wording not found in the system prompt');
}
export const JUDGMENT_RULE_ONE_FRAGMENT = sampleSystemPrompt.slice(ruleOneStart, ruleOneStart + 60);
