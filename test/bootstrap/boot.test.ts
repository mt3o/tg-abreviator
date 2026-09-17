/**
 * The boot sequence's fail-fast path (DESIGN §10 step 5), and the shipped
 * example configuration going through the *real* one.
 *
 * README promises, under "Troubleshooting: config errors on startup", that the
 * process "validates the full resolved configuration — every layer,
 * cross-checked — **before** it touches Telegram or the database, and exits
 * with every problem it found printed as a short list, not a stack trace".
 * Every assertion here is one clause of that sentence: the exit code, the
 * message shape, every problem rather than the first, and — proved by the fact
 * that these tests open no database and no socket — the ordering.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readConfigFile } from '../../src/bootstrap/config-file.js';
import { run } from '../../src/bootstrap/run.js';
import { createConfig } from '../../src/adapters/outbound/config/index.js';
import { ConfigValidationError } from '../../src/domain/errors.js';
import type { EnvSource } from '../../src/config/schema.js';
import { FakeSettingsStore } from '../fakes/fake-settings-store.js';

const EXAMPLE_CONFIG = resolvePath('config.example.yaml');

/** Everything DESIGN §10 puts in the env layer, for a boot that should succeed. */
const COMPLETE_ENV: EnvSource = {
  BOT_TOKEN: '123456:test-token',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPERATOR_USER_IDS: '33',
};

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'tg-abreviator-boot-'));
}

describe('run() — the fail-fast path', () => {
  it('exits 1 with a readable message when there is no config file', async () => {
    const messages: string[] = [];

    const code = await run({
      env: {},
      cwd: emptyDir(),
      stderr: (message) => messages.push(message),
    });

    expect(code).toBe(1);
    expect(messages.join('\n')).toContain('config file not found');
    // A short list, not a stack trace.
    expect(messages.join('\n')).not.toContain('at Object.');
  });

  it('names the missing bot token rather than crashing inside an adapter', async () => {
    const messages: string[] = [];

    const code = await run({
      env: { CONFIG_PATH: EXAMPLE_CONFIG },
      cwd: emptyDir(),
      stderr: (message) => messages.push(message),
    });

    expect(code).toBe(1);
    const output = messages.join('\n');
    expect(output).toContain('configuration failed validation:');
    // An absent `BOT_TOKEN` leaves `telegram.token` with no value in any
    // layer, so it is the resolved *shape* check that catches it first
    // (`config-layers-adapter.ts`) and the cross-check below never runs. One
    // readable line naming the path, either way — never a stack trace.
    expect(output).toContain('telegram.token');
    expect(output).not.toContain('at Object.');
  });

  it('reports every remaining problem at once, not the first one', async () => {
    const messages: string[] = [];

    const code = await run({
      env: { CONFIG_PATH: EXAMPLE_CONFIG, BOT_TOKEN: '123456:test-token' },
      cwd: emptyDir(),
      stderr: (message) => messages.push(message),
    });

    expect(code).toBe(1);
    const output = messages.join('\n');
    // Exactly README's "Troubleshooting: config errors on startup" example:
    // an unset API key *and* an empty allowlist, both in one list.
    expect(output).toContain('environment variable ANTHROPIC_API_KEY is not set');
    expect(output).toContain('telegram.allowlist: the allowlist is empty');
  });
});

describe('run() — resource unwinding', () => {
  it('releases the single-instance lock when boot fails after taking it', async () => {
    const dir = emptyDir();
    // YAML is a superset of JSON, so this is a valid — and minimal — config
    // file: everything else comes from the `defaults` layer (DESIGN §10).
    // `database.path` points at a directory, so SQLite cannot open it and boot
    // fails at the step *after* the lockfile is acquired.
    writeFileSync(
      join(dir, 'config.yaml'),
      JSON.stringify({
        telegram: { allowlist: [-1001234567890] },
        database: { path: dir, lockPath: join(dir, 'app.lock') },
      }),
      'utf8',
    );
    const messages: string[] = [];

    const code = await run({
      env: { ...COMPLETE_ENV, CONFIG_PATH: join(dir, 'config.yaml') },
      cwd: dir,
      stderr: (message) => messages.push(message),
    });

    expect(code).toBe(1);
    // It really did get past configuration and take the lock before failing:
    // the failure is SQLite's, reported with its stack to the local log only.
    expect(messages.join('\n')).not.toContain('configuration failed validation');
    expect(messages.join('\n')).toContain('database');
    // A stranded lockfile would make the next start refuse for the wrong
    // reason, and the operator would go hunting for a process that is not
    // there (README, "Single instance, enforced").
    expect(existsSync(join(dir, 'app.lock.lock'))).toBe(false);
  });
});

describe('config.example.yaml through the real boot path', () => {
  it('needs exactly one edit — the allowlist — once the env layer carries the secrets', async () => {
    const fileConfig = readConfigFile(EXAMPLE_CONFIG);

    let thrown: unknown;
    try {
      await createConfig({ fileConfig, env: COMPLETE_ENV, settingsStore: new FakeSettingsStore() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).issues.map((issue) => issue.path)).toEqual([
      'telegram.allowlist',
    ]);
  });

  it('resolves cleanly once the operator has filled the allowlist in', async () => {
    const fileConfig = readConfigFile(EXAMPLE_CONFIG) as Record<string, unknown>;
    const telegram = { ...(fileConfig.telegram as Record<string, unknown>), allowlist: [-1001234567890] };

    const config = await createConfig({
      fileConfig: { ...fileConfig, telegram },
      env: COMPLETE_ENV,
      settingsStore: new FakeSettingsStore(),
    });

    expect(config.get('telegram').token).toBe(COMPLETE_ENV.BOT_TOKEN);
    expect(config.get('telegram').operatorUserIds).toEqual([33]);
    expect(config.get('bot').commandName).toBe('tldr');
    // DESIGN §11: no DSN means the no-op reporter, not a crash.
    expect(config.get('observability').dsn).toBeNull();
    // Every section the resolved schema requires is present and typed.
    expect(config.get('limits').maxInputTokens).toBeGreaterThan(0);
  });
});
