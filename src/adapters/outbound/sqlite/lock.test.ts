/**
 * WS1 DoD: "a test proving the lockfile rejects a second process."
 *
 * DESIGN §3: "Two processes polling one token get 409 Conflict. Exactly one
 * instance. Enforced by lockfile." A second acquire attempt on the same path
 * must fail immediately — `retries: 0` — never queue.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LockHeldError } from '../../../domain/errors.js';
import { acquireDatabaseLock } from './lock.js';
import type { DatabaseLock } from './lock.js';

describe('SQLite single-instance lockfile (DESIGN §3)', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-abreviator-lock-'));
    lockPath = join(dir, 'tg-abreviator.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a second process while the first still holds the lock', async () => {
    const first = await acquireDatabaseLock(lockPath);

    await expect(acquireDatabaseLock(lockPath)).rejects.toBeInstanceOf(LockHeldError);

    await first.release();
  });

  it('lets a second process in once the first releases', async () => {
    const first = await acquireDatabaseLock(lockPath);
    await first.release();

    const second: DatabaseLock = await acquireDatabaseLock(lockPath);
    await second.release();
  });

  it('carries the lock path on the error, never a bare stack trace', async () => {
    const first = await acquireDatabaseLock(lockPath);

    try {
      await acquireDatabaseLock(lockPath);
      expect.unreachable('expected LockHeldError');
    } catch (error) {
      expect(error).toBeInstanceOf(LockHeldError);
      expect((error as LockHeldError).lockPath).toBe(lockPath);
      expect((error as LockHeldError).report).toBe(true);
    } finally {
      await first.release();
    }
  });
});
