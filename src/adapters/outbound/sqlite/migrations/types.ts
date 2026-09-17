/**
 * Forward-only numbered migrations (PLAN, WS1).
 *
 * Each migration is a plain TypeScript module rather than a loose `.sql`
 * file: `tsconfig.build.json` only compiles `.ts`, and a `.sql` asset would
 * silently vanish from `dist` with no build step to copy it back in. A
 * migration's `sql` is therefore embedded as a string, applied verbatim
 * inside one transaction, and recorded in `_migrations` so it never runs
 * twice.
 */
export interface Migration {
  /** Strictly increasing, gapless from 1. Applied in this order, once each. */
  readonly id: number;
  /** Human-readable, for `_migrations.name` and error messages. */
  readonly name: string;
  /** Raw SQL executed with `Database#exec`, inside one transaction. */
  readonly sql: string;
}
