/**
 * Single-instance enforcement (DESIGN §3): "Two processes polling one token
 * get 409 Conflict. Exactly one instance. Enforced by lockfile."
 *
 * `proper-lockfile` takes an advisory `mkdir`-based lock next to the target
 * path (atomic on every filesystem this bot runs on). `retries: 0` is the
 * point — a second instance must fail immediately and loudly, never queue
 * up waiting for the first one to exit.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { lock as acquireLockfile } from 'proper-lockfile';

import { LockHeldError } from '../../../domain/errors.js';

export interface DatabaseLock {
  /** Releases the lock. Safe to call once; calling it twice is a caller bug. */
  release(): Promise<void>;
}

function isLockedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ELOCKED'
  );
}

/**
 * Acquires the single-instance lock at `lockPath`, throwing `LockHeldError`
 * immediately if another live process already holds it.
 *
 * `realpath: false` so the target need not already exist as a real file —
 * the lock is a sibling `${lockPath}.lock` directory, created atomically by
 * `mkdir`, not the file itself.
 */
export async function acquireDatabaseLock(lockPath: string): Promise<DatabaseLock> {
  const dir = dirname(lockPath);
  if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });

  try {
    const release = await acquireLockfile(lockPath, { realpath: false, retries: 0 });
    return {
      release: async () => {
        await release();
      },
    };
  } catch (error) {
    if (isLockedError(error)) {
      throw new LockHeldError(lockPath, { cause: error });
    }
    throw error;
  }
}
