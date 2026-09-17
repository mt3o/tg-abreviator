// @ts-check
/**
 * Lint configuration, and — more importantly — the mechanical enforcement of
 * the hexagonal boundaries (DESIGN §3, "The rule that keeps this honest").
 *
 *   domain      -> domain only
 *   config      -> domain, config        (Zod schemas; the only core zone with a dependency)
 *   application -> domain, config, application
 *   adapters    -> application, config, domain, adapters
 *   bootstrap   -> anything
 *
 * "No grammY type, no Anthropic SDK type, no better-sqlite3 type and no
 * config-layers type may appear in src/domain or src/application. … This is the
 * rule that erodes first in every hexagonal codebase, usually via one innocent
 * `import type`. So it is enforced mechanically, not by discipline."
 *
 * `src/config` is its own zone rather than part of `domain` because it imports
 * zod, and the domain is pure. Nothing changes about the stated rule set: the
 * domain still imports nothing but the domain.
 *
 * Two mechanisms, deliberately:
 *
 *   - `boundaries/element-types` for *layer* violations (domain importing an
 *     adapter);
 *   - `no-restricted-imports` for *package* violations (application importing
 *     grammY). It flags `import type` as well, which is the case that matters.
 *
 * A deliberately-failing fixture lives in `eslint-fixtures/boundaries/` and is
 * excluded from the normal run. Prove the rules actually fire with:
 *
 *     npm run lint:boundaries-fixture
 *
 * which passes only when eslint reports those violations. See
 * `eslint-fixtures/README.md`.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/** The single swap point for Temporal (DESIGN §3). */
const temporalRestriction = {
  name: 'temporal-polyfill',
  message:
    'Import Temporal from src/domain/time/temporal.js — the single swap point (DESIGN §3).',
};

/** Packages that must never be reachable from domain, application or config. */
const forbiddenInCore = [
  {
    group: [
      'grammy',
      'grammy/*',
      '@grammyjs/*',
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/*',
      'better-sqlite3',
      '@sentry/*',
      'config-layers',
      'proper-lockfile',
      'pino',
      'pino-pretty',
      'dotenv',
      'yaml',
    ],
    message:
      'No grammY, Anthropic SDK, better-sqlite3, Sentry or config-layers type may appear outside an adapter (DESIGN §3). Map it to a domain type at the boundary.',
  },
];

/** The domain is pure: no I/O, no framework types, no validation library.
 *  `node:crypto` is deliberately absent from this list — the dedupe key is a
 *  pure hash and lives in the domain (DESIGN §9). */
const forbiddenInDomain = [
  ...forbiddenInCore,
  {
    group: ['zod', 'zod/*'],
    message: 'Validation lives in src/config and the adapters, not in the domain.',
  },
  {
    group: [
      'fs',
      'path',
      'node:fs',
      'node:fs/*',
      'node:path',
      'node:os',
      'node:net',
      'node:http',
      'node:https',
      'node:child_process',
      'node:process',
      'node:worker_threads',
      'node:timers',
      'node:timers/*',
    ],
    message: 'The domain performs no I/O (DESIGN §3). Put this behind a port.',
  },
];

const ambientStateRestrictions = [
  {
    selector: "MemberExpression[object.name='Temporal'][property.name='Now']",
    message:
      'Time comes from the Clock port (DESIGN §3). Temporal.Now belongs to adapters and tests.',
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'Use Temporal through the Clock port, not Date.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use the Clock port, not Date.now().',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Randomness comes from the IdGenerator port (DESIGN §3, §5).',
  },
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: 'Environment access belongs in an adapter, behind the Config port (DESIGN §10).',
  },
];

/** `{ element: { type } }` selector, the v7 syntax. */
const el = (/** @type {string} */ type) => ({ element: { type } });
const els = (/** @type {string[]} */ types) => ({ element: { types: { anyOf: types } } });

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Deliberately-failing fixture; see npm run lint:boundaries-fixture.
      'eslint-fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    plugins: { boundaries },
    settings: {
      // eslint-plugin-boundaries resolves imports through eslint-module-utils.
      // Everything in this repo is NodeNext, so every relative import carries a
      // `.js` extension that points at a `.ts` file; the default node resolver
      // cannot follow that, silently classifies the dependency as unknown, and
      // the boundary rules then pass on everything. Hence the TypeScript
      // resolver — and hence `npm run lint:boundaries-fixture`, which is what
      // caught exactly that failure mode.
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
      // Element patterns match *folders*, not files.
      'boundaries/elements': [
        // The deliberately-failing fixtures are classified as the layer they
        // impersonate, so they are judged by exactly the rules that guard
        // src/domain and src/application. Listed first: first match wins.
        { type: 'domain', pattern: 'eslint-fixtures/boundaries/domain' },
        { type: 'application', pattern: 'eslint-fixtures/boundaries/application' },
        { type: 'domain', pattern: 'src/domain' },
        { type: 'config', pattern: 'src/config' },
        { type: 'application', pattern: 'src/application' },
        { type: 'adapters', pattern: 'src/adapters' },
        { type: 'bootstrap', pattern: 'src/bootstrap' },
        { type: 'test', pattern: 'test' },
        { type: 'eval', pattern: 'eval' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message: '{{file.type}} may not import {{dependency.type}} (DESIGN §3)',
          policies: [
            { from: [el('domain')], allow: [{ to: [el('domain')] }] },
            { from: [el('config')], allow: [{ to: [els(['domain', 'config'])] }] },
            {
              from: [el('application')],
              allow: [{ to: [els(['domain', 'config', 'application'])] }],
            },
            {
              from: [el('adapters')],
              allow: [{ to: [els(['domain', 'config', 'application', 'adapters'])] }],
            },
            {
              from: [el('bootstrap')],
              allow: [
                { to: [els(['domain', 'config', 'application', 'adapters', 'bootstrap'])] },
              ],
            },
            {
              from: [els(['test', 'eval'])],
              allow: [
                {
                  to: [
                    els(['domain', 'config', 'application', 'adapters', 'bootstrap', 'test', 'eval']),
                  ],
                },
              ],
            },
          ],
        },
      ],
      'no-restricted-imports': ['error', { paths: [temporalRestriction] }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // The pure core.
  {
    files: ['src/domain/**/*.ts', 'eslint-fixtures/boundaries/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [temporalRestriction], patterns: forbiddenInDomain },
      ],
      'no-restricted-syntax': ['error', ...ambientStateRestrictions],
    },
  },
  {
    files: [
      'src/application/**/*.ts',
      'src/config/**/*.ts',
      'eslint-fixtures/boundaries/application/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [temporalRestriction], patterns: forbiddenInCore },
      ],
      'no-restricted-syntax': ['error', ...ambientStateRestrictions],
    },
  },

  // The single file allowed to know where Temporal comes from.
  {
    files: ['src/domain/time/temporal.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Adapters and the composition root talk to the outside world by definition.
  {
    files: ['src/adapters/**/*.ts', 'src/bootstrap/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Tests may reach for real time and real randomness when the thing under test
  // is the adapter that owns them.
  {
    files: ['test/**/*.ts', 'eval/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },

  // Repo-root tooling belongs to no zone.
  {
    files: ['*.js', '*.ts'],
    rules: {
      'boundaries/dependencies': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
