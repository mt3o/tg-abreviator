/**
 * Proves the import-boundary rules actually fire.
 *
 *     npm run lint:boundaries-fixture
 *
 * `eslint-fixtures/**` is ignored by the normal lint run (otherwise `npm run
 * lint` could never pass), which means the rules protecting the architecture
 * would themselves be untested. This script lints the fixtures with ignores
 * disabled and asserts that each one produced the violation it was written to
 * produce — and, just as importantly, that it produced it for the *expected
 * rule*, so a syntax error cannot masquerade as a passing check.
 */
import { ESLint } from 'eslint';

const EXPECTED = [
  {
    file: 'eslint-fixtures/boundaries/domain/imports-application.ts',
    ruleId: 'boundaries/dependencies',
    why: 'domain -> application is a layer violation (DESIGN §3)',
  },
  {
    file: 'eslint-fixtures/boundaries/domain/imports-node-fs.ts',
    ruleId: 'no-restricted-imports',
    why: 'the domain performs no I/O (DESIGN §3)',
  },
  {
    file: 'eslint-fixtures/boundaries/application/imports-grammy.ts',
    ruleId: 'no-restricted-imports',
    why: 'no grammY type may appear in application (DESIGN §3)',
  },
];

const eslint = new ESLint({ ignore: false });
const results = await eslint.lintFiles(['eslint-fixtures/boundaries/**/*.ts']);

let failed = false;
for (const expectation of EXPECTED) {
  const result = results.find((r) => r.filePath.endsWith(expectation.file));
  const hit = result?.messages.some((m) => m.ruleId === expectation.ruleId) ?? false;
  if (hit) {
    console.log(`ok   ${expectation.ruleId} fired on ${expectation.file}`);
  } else {
    failed = true;
    console.error(
      `FAIL ${expectation.ruleId} did NOT fire on ${expectation.file} — ${expectation.why}`,
    );
    for (const message of result?.messages ?? []) {
      console.error(`       got: ${message.ruleId ?? 'parse error'}: ${message.message}`);
    }
  }
}

if (failed) {
  console.error('\nThe import-boundary rules are not protecting anything. Fix eslint.config.js.');
  process.exit(1);
}
console.log('\nAll boundary rules fired as expected.');
