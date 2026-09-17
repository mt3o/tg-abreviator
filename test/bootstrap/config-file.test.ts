/**
 * Step 1 of DESIGN §10's boot sequence: reading `config.yaml`.
 *
 * The two failures that happen before Zod ever sees the file — it is missing,
 * or it is not YAML — have to arrive in the same shape as a semantic failure,
 * because README promises an operator one format: "every problem it found
 * printed as a short list, not a stack trace".
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG_FILENAME,
  readConfigFile,
  resolveConfigPath,
} from '../../src/bootstrap/config-file.js';
import { ConfigValidationError } from '../../src/domain/errors.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tg-abreviator-config-'));
}

describe('resolveConfigPath', () => {
  it('defaults to ./config.yaml next to the process, which is what the image mounts', () => {
    expect(resolveConfigPath(undefined, '/app')).toBe(`/app/${DEFAULT_CONFIG_FILENAME}`);
    expect(resolveConfigPath('', '/app')).toBe(`/app/${DEFAULT_CONFIG_FILENAME}`);
  });

  it('honours CONFIG_PATH, relative or absolute', () => {
    expect(resolveConfigPath('conf/bot.yaml', '/app')).toBe('/app/conf/bot.yaml');
    expect(resolveConfigPath('/etc/tg-abreviator.yaml', '/app')).toBe('/etc/tg-abreviator.yaml');
  });
});

describe('readConfigFile', () => {
  it('parses a YAML document into a plain value', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'telegram:\n  allowlist: [-100123]\n', 'utf8');

    expect(readConfigFile(path)).toEqual({ telegram: { allowlist: [-100123] } });
  });

  it('treats an empty file as an empty layer rather than null', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, '', 'utf8');

    expect(readConfigFile(path)).toEqual({});
  });

  it('fails readably when the file is missing, naming the fix', () => {
    const path = join(tempDir(), 'config.yaml');

    let thrown: unknown;
    try {
      readConfigFile(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).message).toContain('config file not found');
    expect((thrown as ConfigValidationError).message).toContain('config.example.yaml');
    expect((thrown as ConfigValidationError).issues).toHaveLength(1);
  });

  it('fails readably on malformed YAML instead of throwing a parser error', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'telegram:\n  allowlist: [-100123\nbot: {\n', 'utf8');

    let thrown: unknown;
    try {
      readConfigFile(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).message).toContain('not valid YAML');
  });
});
