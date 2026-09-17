/**
 * Checks a fixture's written expectation against the rendered answer text.
 *
 * Deliberately a substring check, not an LLM judge (DESIGN §12: "No
 * LLM-as-judge scoring — with a handful of fixtures you read them yourself in
 * three minutes and learn more than a number would tell you"). This is a
 * heuristic guard that makes an obvious regression visible in the report
 * without requiring a human to read every run — it is not a claim that a
 * passing fixture is a correct answer, or that a failing one is wrong.
 */
import type { ExpectationCheck, FixtureExpectation } from './types.js';

export function checkExpectations(text: string, expectation: FixtureExpectation): ExpectationCheck {
  const haystack = text.toLowerCase();

  const missing = (expectation.mustContain ?? []).filter(
    (needle) => !haystack.includes(needle.toLowerCase()),
  );

  const anyList = expectation.mustContainAny ?? [];
  const anyMissing = anyList.length > 0 && !anyList.some((needle) => haystack.includes(needle.toLowerCase()));

  const forbiddenFound = (expectation.mustNotContain ?? []).filter((needle) =>
    haystack.includes(needle.toLowerCase()),
  );

  return {
    pass: missing.length === 0 && !anyMissing && forbiddenFound.length === 0,
    missing,
    anyMissing,
    forbiddenFound,
  };
}
