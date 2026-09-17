/**
 * Layer 2 of DESIGN §10: reading `config.yaml` off disk.
 *
 * The boot sequence is "parse `config.yaml`, Zod-validate each layer's shape
 * *before* handing it to `fromLayers`, build, cross-validate the resolved
 * snapshot, fail fast with a readable message". This file is step 1 only — it
 * returns an untyped value and makes no judgement about it, because every
 * judgement belongs to `src/config/schema.ts` (the frozen Phase 0 contract)
 * and to WS7's adapter, which already report *every* problem at once instead
 * of the first.
 *
 * The two failures that can happen before Zod ever sees the file — it is not
 * there, or it is not YAML — are turned into the same `ConfigValidationError`
 * shape, so `main.ts` has exactly one error to print and the operator sees one
 * format (README, "Troubleshooting: config errors on startup").
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ConfigValidationError } from '../domain/errors.js';

/** Bind-mounted at `/app/config.yaml` in the image; `./config.yaml` otherwise. */
export const DEFAULT_CONFIG_FILENAME = 'config.yaml';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Absolute path of the config file, given `CONFIG_PATH` (or the default) and a cwd. */
export function resolveConfigPath(configPath: string | undefined, cwd: string): string {
  const raw = configPath === undefined || configPath.length === 0 ? DEFAULT_CONFIG_FILENAME : configPath;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * Reads and parses the file. Throws `ConfigValidationError` — never a raw
 * `Error` — so a missing or malformed file exits with the same readable list
 * as a semantically invalid one, rather than a stack trace.
 *
 * A missing file is fatal rather than an empty layer: `telegram.allowlist` can
 * only come from the file (DESIGN §10 keeps it out of env), and an empty
 * allowlist means the bot refuses and leaves every chat it is invited to
 * (DESIGN §5). Failing here says why; falling through would say "the allowlist
 * is empty" and leave the operator hunting for a file they never created.
 */
export function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw new ConfigValidationError(
        [
          {
            path,
            message: 'config file not found — copy config.example.yaml to config.yaml and edit it',
          },
        ],
        { cause: error },
      );
    }
    throw error;
  }

  try {
    return parseYaml(text) ?? {};
  } catch (error) {
    throw new ConfigValidationError(
      [{ path, message: `not valid YAML: ${error instanceof Error ? error.message : String(error)}` }],
      { cause: error },
    );
  }
}
