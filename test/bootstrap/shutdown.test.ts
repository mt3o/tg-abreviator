/**
 * Graceful shutdown (DESIGN §3, Wave 3: "finish the in-flight poll, flush the
 * reporter, release the lock").
 *
 * The order matters and so does the failure behaviour: a failed flush must not
 * strand the lockfile, because the next start would then refuse for the wrong
 * reason and the operator would be debugging a ghost instance.
 */
import { describe, expect, it, vi } from 'vitest';

import { installSignalHandlers, runShutdown, TERMINATION_SIGNALS } from '../../src/bootstrap/shutdown.js';
import type { ShutdownStep } from '../../src/bootstrap/shutdown.js';

function step(name: string, order: string[], fail = false): ShutdownStep {
  return {
    name,
    run: async () => {
      order.push(name);
      if (fail) throw new Error(`${name} failed`);
      await Promise.resolve();
    },
  };
}

describe('runShutdown', () => {
  it('runs every step in order', async () => {
    const order: string[] = [];
    await runShutdown(
      [step('reporter-flush', order), step('database-close', order), step('lock-release', order)],
      () => undefined,
    );

    expect(order).toEqual(['reporter-flush', 'database-close', 'lock-release']);
  });

  it('keeps going after a failing step, so the lock is always released', async () => {
    const order: string[] = [];
    const logged: { step: string; failed: boolean }[] = [];

    await runShutdown(
      [
        step('reporter-flush', order, true),
        step('database-close', order),
        step('lock-release', order),
      ],
      (event) => logged.push({ step: event.step, failed: event.error !== undefined }),
    );

    expect(order).toEqual(['reporter-flush', 'database-close', 'lock-release']);
    expect(logged).toEqual([
      { step: 'reporter-flush', failed: true },
      { step: 'database-close', failed: false },
      { step: 'lock-release', failed: false },
    ]);
  });
});

describe('installSignalHandlers', () => {
  it('terminates once and forces on the second signal, then unregisters cleanly', () => {
    const before = TERMINATION_SIGNALS.map((signal) => process.listenerCount(signal));
    const onTerminate = vi.fn();
    const onForce = vi.fn();

    const remove = installSignalHandlers({ onTerminate, onForce });
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    process.emit('SIGINT');

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('SIGTERM');
    expect(onForce).toHaveBeenCalledTimes(2);

    remove();
    expect(TERMINATION_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});
