/**
 * Graceful shutdown (DESIGN §3, `docs/PLAN.md` Wave 3: "finish the in-flight
 * poll, flush the reporter, release the lock").
 *
 * The order is the whole content of this file:
 *
 * 1. **Abort the poll loop.** `TelegramPoller.run()` checks the signal between
 *    rounds, so the in-flight `getUpdates` and everything it already fetched
 *    finishes and its offset is persisted. Killing it mid-batch would either
 *    lose updates or replay them.
 * 2. **Flush the reporter**, before anything else can fail: an error queued
 *    during the last poll is exactly the one worth having.
 * 3. **Close the database**, so WAL is checkpointed while the lock still
 *    guarantees nobody else is writing.
 * 4. **Release the lock last.** A second instance that starts the microsecond
 *    this returns must find a closed, consistent database — DESIGN §1: two
 *    pollers on one token is `409 Conflict`, and the lockfile is what makes
 *    "exactly one" true.
 *
 * Every step runs even if an earlier one threw. A failed flush must not strand
 * the lockfile: the next start would then refuse for the wrong reason.
 */
export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export type ShutdownLog = (event: { readonly step: string; readonly error?: unknown }) => void;

/** Runs every step in order, reporting failures rather than stopping on them. */
export async function runShutdown(steps: readonly ShutdownStep[], log: ShutdownLog): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
      log({ step: step.name });
    } catch (error) {
      log({ step: step.name, error });
    }
  }
}

/** The signals a container runtime actually sends (compose `stop_grace_period`, Ctrl-C). */
export const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGINT', 'SIGTERM']);

export interface SignalHandlerOptions {
  /** Called on the first signal: begin the graceful path. */
  readonly onTerminate: (signal: NodeJS.Signals) => void;
  /**
   * Called on a *second* signal, when the operator has stopped waiting. The
   * default caller exits immediately: the in-flight poll can take as long as
   * the long-poll timeout, and refusing to die is worse than a hard stop.
   */
  readonly onForce: (signal: NodeJS.Signals) => void;
}

/** Registers the handlers and returns the function that removes them again. */
export function installSignalHandlers(options: SignalHandlerOptions): () => void {
  let terminating = false;
  const handlers = TERMINATION_SIGNALS.map((signal) => {
    const handler = (): void => {
      if (terminating) {
        options.onForce(signal);
        return;
      }
      terminating = true;
      options.onTerminate(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}
