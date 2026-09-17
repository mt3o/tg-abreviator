/**
 * The composition root's object graph (DESIGN §3, `docs/PLAN.md` Wave 3).
 *
 * "Instantiates each adapter, injects it into the use cases, starts the
 * poller. It contains **wiring only**. Any logic that appears here belongs in
 * a use case or the domain — a fat composition root is the standard way a
 * hexagonal codebase quietly stops being one."
 *
 * So this file is deliberately boring: it takes every driven port as an
 * argument and returns the driving side, and there is not a single `if` in it
 * that decides anything about behaviour. Every decision that looks like it
 * could live here lives one layer down instead:
 *
 * - guards, dedupe and the usage context → `usecases/guarded-answer.ts`;
 * - which model serves a call → WS4's router, read per chat by the pipeline;
 * - which reporter to use → `createErrorReporter` (WS8), called by `main.ts`
 *   with values read from `Config`.
 *
 * Taking the ports as an argument (rather than constructing them) is also what
 * makes the Wave 3 DoD testable: the end-to-end test builds this exact graph
 * over Phase 0's fakes, so what it exercises is the wiring that ships.
 *
 * Two wrappings here are the whole point of the file, because each is a
 * decorator its author deliberately could not apply itself:
 *
 * - `UsageRecordingLlm` wraps the `Llm` port, so **every** provider call made
 *   anywhere inside an invocation is billed (DESIGN §4) without the pipeline
 *   or the compactor knowing it exists;
 * - `GuardedSummarizeRange` / `GuardedAnswerQuestion` wrap the two driving
 *   ports, so the cooldown, dedupe, concurrency, daily-cap and global-budget
 *   sequence (DESIGN §9) sits between the dispatcher and the pipeline.
 */
import { CommandDispatcher } from '../adapters/inbound/telegram/dispatch.js';
import type { CommandDeps } from '../adapters/inbound/telegram/commands/types.js';
import { TelegramPoller } from '../adapters/inbound/telegram/poller.js';
import type { TelegramUpdatesSource } from '../adapters/inbound/telegram/poller.js';
import { GuardedPipeline } from '../application/guards/guarded-pipeline.js';
import type { ChatGateway } from '../application/ports/driven/chat-gateway.js';
import type { ChunkStore } from '../application/ports/driven/chunk-store.js';
import type { Clock } from '../application/ports/driven/clock.js';
import type { Config } from '../application/ports/driven/config.js';
import type { ErrorReporter } from '../application/ports/driven/error-reporter.js';
import type { IdGenerator } from '../application/ports/driven/id-generator.js';
import type { Llm } from '../application/ports/driven/llm.js';
import type { MaintenanceStore } from '../application/ports/driven/maintenance-store.js';
import type { MessageStore } from '../application/ports/driven/message-store.js';
import type { OptOutStore } from '../application/ports/driven/opt-out-store.js';
import type { PollStateStore } from '../application/ports/driven/poll-state-store.js';
import type { PseudonymStore } from '../application/ports/driven/pseudonym-store.js';
import type { SettingsStore } from '../application/ports/driven/settings-store.js';
import type { GlobalUsageStore, UsageStore } from '../application/ports/driven/usage-store.js';
import type { AnswerQuestion } from '../application/ports/driving/answer-question.js';
import type { ForgetUser } from '../application/ports/driving/forget-user.js';
import type { IngestMessage } from '../application/ports/driving/ingest-message.js';
import type { PurgeChat } from '../application/ports/driving/purge-chat.js';
import type { ReadUsage } from '../application/ports/driving/read-usage.js';
import type { SummarizeRange } from '../application/ports/driving/summarize-range.js';
import type { UpdateChatSetting } from '../application/ports/driving/update-chat-setting.js';
import { UsageRecordingLlm } from '../application/usage/usage-recording-llm.js';
import { ReadUsageUseCase } from '../application/usage/read-usage.js';
import { zeroPrices } from '../application/usage/usage-writer.js';
import { AnswerQuestionUseCase } from '../application/usecases/answer-question.js';
import { ForgetUserUseCase } from '../application/usecases/forget-user.js';
import {
  GuardedAnswerQuestion,
  GuardedSummarizeRange,
} from '../application/usecases/guarded-answer.js';
import { IngestMessageUseCase } from '../application/usecases/ingest-message.js';
import { PurgeChatUseCase } from '../application/usecases/purge-chat.js';
import { SummarizeRangeUseCase } from '../application/usecases/summarize-range.js';
import { SweepExpiredUseCase } from '../application/usecases/sweep-expired.js';
import { UpdateChatSettingUseCase } from '../application/usecases/update-chat-setting.js';

/** Every driven port the application needs, already constructed. */
export interface DrivenPorts {
  readonly messages: MessageStore;
  readonly chunks: ChunkStore;
  readonly settings: SettingsStore;
  readonly optOuts: OptOutStore;
  readonly usage: UsageStore;
  readonly globalUsage: GlobalUsageStore;
  readonly pollState: PollStateStore;
  readonly pseudonyms: PseudonymStore;
  readonly maintenance: MaintenanceStore;
  readonly config: Config;
  readonly gateway: ChatGateway;
  readonly llm: Llm;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly reporter: ErrorReporter;
  readonly updatesSource: TelegramUpdatesSource;
}

/** The driving side, assembled. `main.ts` runs `poller`; the tests read the rest. */
export interface Application {
  readonly poller: TelegramPoller;
  readonly dispatcher: CommandDispatcher;
  readonly ingest: IngestMessage;
  readonly summarizeRange: SummarizeRange;
  readonly answerQuestion: AnswerQuestion;
  readonly forgetUser: ForgetUser;
  readonly purgeChat: PurgeChat;
  readonly updateChatSetting: UpdateChatSetting;
  readonly readUsage: ReadUsage;
  /** DESIGN §5's rolling TTL. Driven by a timer in `run.ts`, not by an update. */
  readonly sweepExpired: SweepExpiredUseCase;
  /** The `Llm` the use cases actually call: the usage-recording decorator. */
  readonly billedLlm: Llm;
}

export function buildApplication(ports: DrivenPorts): Application {
  const {
    messages,
    chunks,
    settings,
    optOuts,
    usage,
    globalUsage,
    pollState,
    pseudonyms,
    maintenance,
    config,
    gateway,
    llm,
    clock,
    ids,
    reporter,
    updatesSource,
  } = ports;

  // DESIGN §4: `unit_prices_json` is stored per row "so editing the config
  // price table does not silently rewrite last month's history". The lookup is
  // by concrete model id, not alias, exactly as the price table is keyed.
  const billedLlm = new UsageRecordingLlm({
    inner: llm,
    usage,
    idGenerator: ids,
    clock,
    priceFor: (model) => config.get('models').prices[model] ?? zeroPrices(),
  });

  const pipelineDeps = { messages, optOuts, settings, config, gateway, llm: billedLlm, clock };
  const guardDeps = {
    pipeline: new GuardedPipeline({ clock, usage, globalUsage, errorReporter: reporter }),
    config,
    gateway,
    settings,
  };

  const summarizeRange: SummarizeRange = new GuardedSummarizeRange(
    guardDeps,
    new SummarizeRangeUseCase(pipelineDeps),
  );
  const answerQuestion: AnswerQuestion = new GuardedAnswerQuestion(
    guardDeps,
    new AnswerQuestionUseCase(pipelineDeps),
  );

  const forgetUser: ForgetUser = new ForgetUserUseCase({
    messages,
    chunks,
    optOuts,
    usage,
    settings,
    pseudonyms,
    ids,
  });
  const purgeChat: PurgeChat = new PurgeChatUseCase({
    messages,
    chunks,
    optOuts,
    usage,
    settings,
    pseudonyms,
    config,
  });
  const updateChatSetting: UpdateChatSetting = new UpdateChatSettingUseCase({ settings, config });
  const readUsage: ReadUsage = new ReadUsageUseCase({ usage, globalUsage, config, clock });

  const sweepExpired = new SweepExpiredUseCase({
    maintenance,
    messages,
    chunks,
    usage,
    pseudonyms,
    config,
    clock,
  });

  const ingest: IngestMessage = new IngestMessageUseCase({ messages, optOuts, config, gateway });

  const commandDeps: CommandDeps = {
    config,
    gateway,
    clock,
    reporter,
    summarizeRange,
    answerQuestion,
    forgetUser,
    purgeChat,
    updateChatSetting,
    readUsage,
  };
  const dispatcher = new CommandDispatcher(commandDeps);

  const poller = new TelegramPoller({
    updatesSource,
    ingest,
    messages,
    pollState,
    config,
    gateway,
    clock,
    reporter,
    // Ingest first, then dispatch: the message carrying the command is itself
    // part of the corpus, and every message ahead of it in the batch must be
    // stored before the command reads the range (DESIGN §1 — the bot can only
    // summarize what it has already persisted).
    onUpdate: async (update) => {
      await dispatcher.dispatch(update);
    },
  });

  return {
    poller,
    dispatcher,
    ingest,
    summarizeRange,
    answerQuestion,
    forgetUser,
    purgeChat,
    updateChatSetting,
    readUsage,
    sweepExpired,
    billedLlm,
  };
}
