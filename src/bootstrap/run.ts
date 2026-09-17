/**
 * The boot sequence (DESIGN §3, `docs/PLAN.md` Wave 3).
 *
 * `main.ts` is the three-line entry point; this is what it runs. Together they
 * are the composition root: the only place permitted to import from every
 * layer, and the only one that knows which concrete adapter implements which
 * port. The split exists so a test can call `run()` without a module-level
 * `await` booting a real process on import. It
 * contains **wiring only**: the object graph itself is `container.ts`, and the
 * order below is the one thing this file decides.
 *
 * ```
 * 1  .env, then the process environment
 * 2  ErrorReporter            <- FIRST, so every failure below is reported
 * 3  process-level handlers   (unhandled exception / rejection, DESIGN §11)
 * 4  config.yaml -> Zod per layer -> LayeredConfig -> resolved cross-check
 * 5  ErrorReporter, again     (now with the resolved DSN/environment/release)
 * 6  the single-instance lockfile
 * 7  SQLite: open, migrate, stores
 * 8  the remaining adapters   (Telegram, Anthropic, system clock/ids)
 * 9  buildApplication()
 * 10 poller.run(signal)       until SIGINT/SIGTERM
 * 11 graceful shutdown        (shutdown.ts: flush, close, release — in order)
 * ```
 *
 * **Why the reporter is first (step 2), twice.** Wave 3's card says "installs
 * the `ErrorReporter` first, so a failure during the rest of boot is itself
 * reported" — and the most likely failure during boot is step 4, config
 * validation, which DESIGN §11 lists explicitly as something worth reporting.
 * But the DSN *is* configuration. The way out is that DESIGN §10 makes the
 * DSN, the environment and the release env-only (`config.yaml` is in git), so
 * they can be read straight from the environment before anything is validated.
 * Step 5 then rebuilds the reporter from the resolved snapshot, which is what
 * picks up `prompts.version` for the `prompt_version` tag. Between the two
 * there is a fully working reporter with the right DSN, which is the point.
 *
 * **Why the database comes after config (steps 4, 7).** `database.path` is
 * itself configuration, and DESIGN §10 step 5 wants the whole resolved
 * snapshot validated before the process touches anything — README promises
 * "it exits with every problem it found printed as a short list, not a stack
 * trace". But `Config` needs a `SettingsStore` for its `chat` layer, which
 * needs the database. `DeferredSettingsStore` breaks exactly that cycle and
 * nothing else.
 */
import { buildApplication } from './container.js';
import { readConfigFile, resolveConfigPath } from './config-file.js';
import { DeferredSettingsStore } from './deferred-settings-store.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { startPeriodicTask } from './scheduler.js';
import { installSignalHandlers, runShutdown } from './shutdown.js';
import type { ShutdownStep } from './shutdown.js';
import { GrammyUpdatesSource } from '../adapters/inbound/telegram/poller.js';
import { AnthropicLlm } from '../adapters/outbound/anthropic/anthropic-llm.js';
import { createConfig } from '../adapters/outbound/config/index.js';
import { createErrorReporter } from '../adapters/outbound/glitchtip/create-error-reporter.js';
import { closeDatabase, openDatabase } from '../adapters/outbound/sqlite/database.js';
import { acquireDatabaseLock } from '../adapters/outbound/sqlite/lock.js';
import { createSqliteStores } from '../adapters/outbound/sqlite/stores.js';
import { RandomIdGenerator } from '../adapters/outbound/system/random-id-generator.js';
import { sweepIntervalMs } from '../application/usecases/sweep-expired.js';
import { SystemClock } from '../adapters/outbound/system/system-clock.js';
import { TelegramChatGateway } from '../adapters/outbound/telegram/chat-gateway.js';
import type { ErrorReporter } from '../application/ports/driven/error-reporter.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { EnvSource, ResolvedConfig } from '../config/schema.js';
import { ConfigValidationError, LockHeldError } from '../domain/errors.js';

type Environment = ResolvedConfig['observability']['environment'];

const ENVIRONMENTS: readonly string[] = ['dev', 'preprod', 'prod', 'test'];

/**
 * The environment tag for the boot-phase reporter, before the config schema
 * has had a chance to reject a typo. An unknown value falls back to the
 * built-in default rather than throwing: the reporter exists precisely so that
 * the *next* step's failure gets reported.
 */
function bootEnvironment(raw: string | undefined): Environment {
  return raw !== undefined && ENVIRONMENTS.includes(raw)
    ? (raw as Environment)
    : DEFAULT_CONFIG.observability.environment;
}

/** DESIGN §11: unset `GLITCHTIP_DSN` selects the no-op adapter. */
function createBootReporter(env: EnvSource): ErrorReporter {
  const dsn = env.GLITCHTIP_DSN;
  return createErrorReporter({
    dsn: dsn === undefined || dsn.length === 0 ? null : dsn,
    environment: bootEnvironment(env.ENVIRONMENT),
    release: env.RELEASE ?? null,
    promptVersion: DEFAULT_CONFIG.prompts.version,
  });
}

/**
 * The readable half of "fail fast with a readable message" (DESIGN §10 step
 * 5). `ConfigValidationError.message` is already the list README documents, so
 * it is printed verbatim and to stderr — not through the logger, whose level
 * comes from the configuration that just failed to load.
 */
function reportBootFailure(
  error: unknown,
  reporter: ErrorReporter,
  stderr: (message: string) => void,
): void {
  reporter.capture(error, { phase: 'boot' });
  if (error instanceof ConfigValidationError) {
    stderr(error.message);
    return;
  }
  if (error instanceof LockHeldError) {
    stderr(
      `${error.message}\n` +
        'Telegram allows exactly one long-poller per bot token (409 Conflict), so this ' +
        'process will not start while another instance is running.',
    );
    return;
  }
  stderr(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

export interface RunOptions {
  readonly env: EnvSource;
  readonly cwd: string;
  /**
   * Where the fail-fast message goes. Defaults to `console.error` — this is
   * the one thing `run()` writes outside the logger, because the log level
   * lives in the configuration that just failed to load, and because README
   * documents the exact text an operator reads out of `docker compose logs`.
   */
  readonly stderr?: (message: string) => void;
}

/**
 * Boots, runs until a termination signal, shuts down. Returns the process exit
 * code rather than calling `process.exit`, so the whole sequence is callable
 * from a test.
 */
export async function run(options: RunOptions): Promise<number> {
  const { env, cwd } = options;
  const stderr = options.stderr ?? ((message: string) => { console.error(message); });
  const reporter: { current: ErrorReporter } = { current: createBootReporter(env) };

  // DESIGN §11: "Report: unhandled exceptions". Installed before anything that
  // can throw asynchronously, and removed again on the way out so that calling
  // `run()` twice in one process (a test) does not stack handlers.
  const onUncaught = (error: unknown): void => {
    reporter.current.capture(error, { phase: 'boot' });
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  /**
   * Cleanup for every resource that has actually been acquired, pushed the
   * moment it is acquired and unwound **last-in-first-out**. Building the list
   * up front would be a lie — a failure between the lockfile and the database
   * would run a teardown for a database that was never opened — and building
   * it at the end would be worse: a failure while opening the database would
   * strand the lockfile, and the next start would refuse for the wrong reason.
   */
  const acquired: ShutdownStep[] = [
    {
      name: 'process-handlers',
      run: async () => {
        process.off('uncaughtException', onUncaught);
        process.off('unhandledRejection', onUncaught);
        await Promise.resolve();
      },
    },
  ];

  /**
   * DESIGN §3 / Wave 3: "finish the in-flight poll, flush the reporter,
   * release the lock". The poll has finished by the time this is called; the
   * flush is first because an error queued during the last poll is exactly the
   * one worth having, and the reporter is only closed once everything that
   * could still report something has been torn down.
   */
  const shutdown = async (log: (event: { step: string; error?: unknown }) => void): Promise<void> => {
    await runShutdown(
      [
        { name: 'reporter-flush', run: async () => { await reporter.current.flush(2000); } },
        ...[...acquired].reverse(),
        { name: 'reporter-close', run: async () => { await reporter.current.close(2000); } },
      ],
      log,
    );
  };

  let logger: Logger | null = null;

  try {
    const configPath = resolveConfigPath(env.CONFIG_PATH, cwd);
    const settingsStore = new DeferredSettingsStore();
    const config = await createConfig({
      fileConfig: readConfigFile(configPath),
      env,
      settingsStore,
    });

    logger = createLogger(config.get('logging').level);
    const observability = config.get('observability');
    reporter.current = createErrorReporter({
      dsn: observability.dsn,
      environment: observability.environment,
      release: observability.release,
      promptVersion: config.get('prompts').version,
    });

    const clock = new SystemClock();
    const ids = new RandomIdGenerator();

    const database = config.get('database');
    const lock = await acquireDatabaseLock(database.lockPath);
    acquired.push({ name: 'lock-release', run: async () => { await lock.release(); } });

    const db = openDatabase({ path: database.path, busyTimeoutMs: database.busyTimeoutMs });
    acquired.push({ name: 'database-close', run: async () => { closeDatabase(db); await Promise.resolve(); } });

    const stores = createSqliteStores(db, { clock, ids });
    // The `chat` config layer can read the database from here on (DESIGN §10).
    settingsStore.bind(stores.settings);

    const telegram = config.get('telegram');
    const gateway = new TelegramChatGateway({ token: telegram.token });
    const llm = new AnthropicLlm({ registry: config.get('models').registry, env });
    const updatesSource = new GrammyUpdatesSource(telegram.token);

    const app = buildApplication({
      messages: stores.messages,
      chunks: stores.chunks,
      settings: stores.settings,
      optOuts: stores.optOuts,
      usage: stores.usage,
      globalUsage: stores.globalUsage,
      pollState: stores.pollState,
      pseudonyms: stores.pseudonyms,
      maintenance: stores.maintenance,
      config,
      gateway,
      llm,
      clock,
      ids,
      reporter: reporter.current,
      updatesSource,
    });

    // DESIGN §5: the rolling TTL is a promise to delete, so something has to
    // run. Once at startup as well as on the interval — a process that
    // restarts more often than `sweepIntervalMinutes` would otherwise never
    // sweep at all.
    const retention = config.get('retention');
    const sweeper = startPeriodicTask({
      intervalMs: sweepIntervalMs(retention.sweepIntervalMinutes),
      immediate: true,
      run: async () => {
        const swept = await app.sweepExpired.execute();
        logger?.info(swept, 'ttl sweep');
      },
      // DESIGN §11: "Report: … TTL sweeper failure." Retention that quietly
      // stopped happening is exactly the kind of thing nobody notices.
      onError: (error) => {
        reporter.current.capture(error, { phase: 'sweeper' });
        logger?.error('ttl sweep failed');
      },
    });
    acquired.push({ name: 'sweeper-stop', run: async () => { await sweeper.stop(); } });

    const controller = new AbortController();
    const removeSignalHandlers = installSignalHandlers({
      onTerminate: (signal) => {
        logger?.info({ signal }, 'termination signal: finishing the in-flight poll');
        controller.abort();
      },
      onForce: (signal) => {
        logger?.warn({ signal }, 'second termination signal: exiting now');
        process.exit(1);
      },
    });

    acquired.push({
      name: 'signal-handlers',
      run: async () => {
        removeSignalHandlers();
        await Promise.resolve();
      },
    });

    logger.info(
      {
        databasePath: database.path,
        allowlistedChats: telegram.allowlist.length,
        commandName: config.get('bot').commandName,
        promptVersion: config.get('prompts').version,
      },
      'started',
    );

    await app.poller.run(controller.signal);
    logger.info('poll loop stopped');
  } catch (error) {
    reportBootFailure(error, reporter.current, stderr);
    await shutdown((event) => {
      if (event.error !== undefined) stderr(`shutdown step ${event.step} failed`);
    });
    return 1;
  }

  await shutdown((event) => {
    if (event.error === undefined) logger?.debug({ step: event.step }, 'shutdown step done');
    else logger?.error({ step: event.step }, 'shutdown step failed');
  });
  return 0;
}
