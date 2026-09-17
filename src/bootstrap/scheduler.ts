/**
 * The one periodic job in the process: the TTL sweeper (DESIGN §5).
 *
 * Small, but not nothing — an interval running an async task has three ways
 * to go wrong, and all three matter for a sweeper that deletes rows:
 *
 * - **Overlap.** A sweep that takes longer than the interval must not be
 *   started again on top of itself. A tick that arrives while one is running
 *   is skipped, not queued: the next one is only minutes away and the work is
 *   idempotent.
 * - **Errors.** A rejected task inside `setInterval` is an unhandled rejection
 *   that takes the process down. It is handed to `onError` instead — DESIGN
 *   §11 lists "TTL sweeper failure" as something to report, and a sweeper that
 *   fails silently would let retention quietly stop happening.
 * - **Shutdown.** `stop()` clears the timer *and* waits for an in-flight run,
 *   so the database is not closed underneath a half-finished sweep.
 */
export interface PeriodicTaskOptions {
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  /** Run once immediately, rather than waiting a whole interval. */
  readonly immediate?: boolean;
}

export interface PeriodicTask {
  /** Clears the timer and awaits whatever is already running. */
  stop(): Promise<void>;
}

export function startPeriodicTask(options: PeriodicTaskOptions): PeriodicTask {
  let inFlight: Promise<void> | null = null;

  const tick = (): void => {
    if (inFlight !== null) return;
    inFlight = options
      .run()
      .catch((error: unknown) => {
        options.onError(error);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  // The poll loop is what keeps this process alive; a pending sweep timer
  // should never be the reason it refuses to exit.
  timer.unref();
  if (options.immediate === true) tick();

  return {
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
