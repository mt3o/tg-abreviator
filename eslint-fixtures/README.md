# eslint-fixtures

Deliberately broken files. They are **not** part of the build: `tsconfig.json`,
`vitest.config.ts` and the normal `eslint .` run all exclude this directory.

They exist because the import-boundary rules in `eslint.config.js` are the only
mechanical enforcement of the architecture (DESIGN §3, "The rule that keeps this
honest"), and a lint rule that is silently misconfigured looks exactly like a
codebase with no violations.

```
npm run lint:boundaries-fixture
```

runs `eslint-fixtures/verify.mjs`, which lints these files with ignores disabled
and asserts that each one reports the specific rule it was written to trip. It
exits non-zero if any rule has stopped firing.

| Fixture | Must trip | Because |
| --- | --- | --- |
| `boundaries/domain/imports-application.ts` | `boundaries/dependencies` | domain imports only domain |
| `boundaries/domain/imports-node-fs.ts` | `no-restricted-imports` | the domain performs no I/O |
| `boundaries/application/imports-grammy.ts` | `no-restricted-imports` | no grammY type in `application` |

`eslint.config.js` classifies `eslint-fixtures/boundaries/domain/**` as the
`domain` element and `eslint-fixtures/boundaries/application/**` as the
`application` element, so these files are judged by exactly the rules that guard
`src/domain` and `src/application`.

If you are adding a boundary rule, add a fixture for it here. If you find
yourself wanting to relax a rule, you are solving the wrong problem
(PLAN, standing instructions).
