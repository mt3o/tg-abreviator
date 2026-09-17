/**
 * The periodic-task runner behind the TTL sweeper (DESIGN §5, §11).
 *
 * Three failure modes, one test each: a slow run being started on top of
 * itself, a rejection escaping into an unhandled rejection that kills the
 * process, and a shutdown that closes the database underneath a half-finished
 * sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startPeriodicTask } from '../../src/bootstrap/scheduler.js';

describe('startPeriodicTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on the interval, and once immediately when asked', async () => {
    let runs = 0;
    const task = startPeriodicTask({
      intervalMs: 1000,
      immediate: true,
      run: async () => {
        runs += 1;
        await Promise.resolve();
      },
      onError: () => expect.unreachable('no error expected'),
    });

    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(4);

    await task.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(4);
  });

  it('skips a tick rather than stacking runs on a slow one', async () => {
    let started = 0;
    // An object field, not a `let`: assigning a `let` inside a callback leaves
    // TypeScript narrowing it to `never` at the call site below.
    const gate: { release: () => void } = { release: () => undefined };
    const task = startPeriodicTask({
      intervalMs: 100,
      run: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
      onError: () => expect.unreachable('no error expected'),
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(1);

    gate.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toBe(2);

    gate.release();
    await task.stop();
  });

  it('hands a rejection to onError instead of crashing the process', async () => {
    const errors: unknown[] = [];
    const task = startPeriodicTask({
      intervalMs: 100,
      run: async () => {
        await Promise.reject(new Error('sweep failed'));
      },
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe('sweep failed');
    // A failed run still releases the slot: the next tick tries again.
    await task.stop();
  });

  it('waits for an in-flight run before returning from stop()', async () => {
    let finished = false;
    const gate: { release: () => void } = { release: () => undefined };
    const task = startPeriodicTask({
      intervalMs: 100,
      immediate: true,
      run: async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        finished = true;
      },
      onError: () => expect.unreachable('no error expected'),
    });

    const stopped = task.stop();
    let stopResolved = false;
    void stopped.then(() => {
      stopResolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(stopResolved).toBe(false);

    gate.release();
    await stopped;
    expect(finished).toBe(true);
  });
});
