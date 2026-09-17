/**
 * `CommandDispatcher` (DESIGN §2, §3; PLAN WS6 DoD).
 *
 * Two things this DoD names explicitly:
 *
 * - a test proving nothing but an explicit command triggers the bot — 100
 *   ordinary messages, including range-shaped text like `-5 stopni jutro` and
 *   `since yesterday`, produce zero invocations;
 * - the tier matrix (also covered directly, against the pure predicate, in
 *   `test/domain/permissions.test.ts`) exercised here end-to-end: every
 *   command handler is reached only when the resolved tier clears
 *   `COMMAND_TIERS`, and a denial never reaches a driving port.
 *
 * Every driving port (`SummarizeRange`, `ForgetUser`, …) is a small in-file
 * spy: Phase 0 ships fakes for the *driven* ports only, and the real driving
 * implementations are Wave 2/3's, not this workstream's to depend on.
 */
import { describe, expect, it } from 'vitest';
import type { Message as TelegramMessage, Update } from 'grammy/types';

import { CommandDispatcher, extractCommandInvocation } from '../../../../src/adapters/inbound/telegram/dispatch.js';
import type { AnswerQuestion, AnswerQuestionCommand } from '../../../../src/application/ports/driving/answer-question.js';
import type { ForgetUser, ForgetUserCommand, ForgetUserResult } from '../../../../src/application/ports/driving/forget-user.js';
import type { PurgeChat, PurgeChatCommand, PurgeChatResult } from '../../../../src/application/ports/driving/purge-chat.js';
import type { ReadUsage, ReadUsageQuery, ReadUsageResult } from '../../../../src/application/ports/driving/read-usage.js';
import type { AnswerOutcome, SummarizeRange, SummarizeRangeCommand } from '../../../../src/application/ports/driving/summarize-range.js';
import type {
  UpdateChatSetting,
  UpdateChatSettingCommand,
  UpdateChatSettingResult,
} from '../../../../src/application/ports/driving/update-chat-setting.js';
import { asChatId, asUserId } from '../../../../src/domain/model/ids.js';
import { FakeChatGateway } from '../../../fakes/fake-chat-gateway.js';
import { FakeClock } from '../../../fakes/fake-clock.js';
import { FakeConfig, TEST_ENV_LAYER } from '../../../fakes/fake-config.js';
import { FakeErrorReporter } from '../../../fakes/fake-error-reporter.js';

/* -------------------------------------------------------------------------- */
/* Driving-port spies                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_ANSWER_OUTCOME: AnswerOutcome = { kind: 'refused', code: 'corpus.empty' };

class SpySummarizeRange implements SummarizeRange {
  readonly calls: SummarizeRangeCommand[] = [];
  outcome: AnswerOutcome = DEFAULT_ANSWER_OUTCOME;
  async execute(command: SummarizeRangeCommand): Promise<AnswerOutcome> {
    this.calls.push(command);
    return await Promise.resolve(this.outcome);
  }
}

class SpyAnswerQuestion implements AnswerQuestion {
  readonly calls: AnswerQuestionCommand[] = [];
  outcome: AnswerOutcome = DEFAULT_ANSWER_OUTCOME;
  async execute(command: AnswerQuestionCommand): Promise<AnswerOutcome> {
    this.calls.push(command);
    return await Promise.resolve(this.outcome);
  }
}

const DEFAULT_FORGET_RESULT: ForgetUserResult = {
  messagesDeleted: 3,
  chunksDeleted: 1,
  usageRowsAnonymised: 2,
  pseudonymDeleted: true,
  optedOut: true,
};

class SpyForgetUser implements ForgetUser {
  readonly calls: ForgetUserCommand[] = [];
  result: ForgetUserResult = DEFAULT_FORGET_RESULT;
  async execute(command: ForgetUserCommand): Promise<ForgetUserResult> {
    this.calls.push(command);
    return await Promise.resolve(this.result);
  }
}

const DEFAULT_PURGE_RESULT: PurgeChatResult = { messagesDeleted: 10, chunksDeleted: 4, usageRowsDeleted: 5 };

class SpyPurgeChat implements PurgeChat {
  readonly calls: PurgeChatCommand[] = [];
  result: PurgeChatResult = DEFAULT_PURGE_RESULT;
  async execute(command: PurgeChatCommand): Promise<PurgeChatResult> {
    this.calls.push(command);
    return await Promise.resolve(this.result);
  }
}

class SpyUpdateChatSetting implements UpdateChatSetting {
  readonly calls: UpdateChatSettingCommand[] = [];
  async execute(command: UpdateChatSettingCommand): Promise<UpdateChatSettingResult> {
    this.calls.push(command);
    if (command.change.kind === 'dmDelivery') {
      return await Promise.resolve({
        kind: 'userPrefs',
        prefs: { chatId: command.chatId, userId: command.requestedBy, dmDelivery: command.change.enabled },
      });
    }
    return await Promise.resolve({
      kind: 'chatSettings',
      settings: {
        chatId: command.chatId,
        tz: command.change.kind === 'timeZone' ? command.change.timeZone : null,
        modelAlias: command.change.kind === 'model' ? command.change.alias : null,
        updatedBy: command.requestedBy,
        updatedAt: command.at,
      },
    });
  }
}

const EMPTY_USAGE_SUMMARY: ReadUsageResult['summary'] = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  since: undefined as unknown as ReadUsageResult['summary']['since'],
  until: undefined as unknown as ReadUsageResult['summary']['until'],
  byModel: {},
};

class SpyReadUsage implements ReadUsage {
  readonly calls: ReadUsageQuery[] = [];
  async execute(query: ReadUsageQuery): Promise<ReadUsageResult> {
    this.calls.push(query);
    return await Promise.resolve({
      scope: query.scope,
      summary: { ...EMPTY_USAGE_SUMMARY, since: query.since, until: query.until },
      budgetRemainingMicros: 1_000_000,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

const HOME_CHAT = asChatId(-1009000001);
const BOT_USER_ID = asUserId(999_000_001);
const BOT_USERNAME = 'tg_abreviator_test_bot';
const MEMBER_ID = 11;
const CHAT_ADMIN_ID = 22;
const OPERATOR_ID = 33;

function makeEnvironment() {
  const gateway = new FakeChatGateway({ identity: { userId: BOT_USER_ID, username: BOT_USERNAME } });
  gateway.setMemberStatus(HOME_CHAT, asUserId(CHAT_ADMIN_ID), 'administrator');
  gateway.setMemberStatus(HOME_CHAT, asUserId(OPERATOR_ID), 'member'); // operator tier comes from config, not chat role
  const config = new FakeConfig({
    file: {
      telegram: { allowlist: [HOME_CHAT] },
      bot: { operatorContact: '@operator', announceOnJoin: true, commandName: 'tldr' },
    },
    env: { ...TEST_ENV_LAYER, telegram: { token: 'test-token', operatorUserIds: [OPERATOR_ID] } },
  });
  const clock = new FakeClock();
  const reporter = new FakeErrorReporter();
  const summarizeRange = new SpySummarizeRange();
  const answerQuestion = new SpyAnswerQuestion();
  const forgetUser = new SpyForgetUser();
  const purgeChat = new SpyPurgeChat();
  const updateChatSetting = new SpyUpdateChatSetting();
  const readUsage = new SpyReadUsage();

  const dispatcher = new CommandDispatcher({
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
  });

  return {
    gateway,
    config,
    clock,
    reporter,
    summarizeRange,
    answerQuestion,
    forgetUser,
    purgeChat,
    updateChatSetting,
    readUsage,
    dispatcher,
  };
}

/* -------------------------------------------------------------------------- */
/* Update builders                                                            */
/* -------------------------------------------------------------------------- */

let nextUpdateId = 1;
let nextMessageId = 1;

const BASE_MESSAGE: TelegramMessage = {
  message_id: 1,
  date: 1758100000,
  chat: { id: HOME_CHAT, type: 'supergroup', title: 'Deploys' },
  from: { id: MEMBER_ID, is_bot: false, first_name: 'Ala' },
  text: 'hello',
};

function plainMessageUpdate(text: string, userId = MEMBER_ID): Update {
  nextMessageId += 1;
  return {
    update_id: nextUpdateId++,
    message: { ...BASE_MESSAGE, message_id: nextMessageId, from: { ...BASE_MESSAGE.from, id: userId }, text },
  } as Update;
}

function commandUpdate(
  command: string,
  args: string,
  options: { userId?: number; mention?: string } = {},
): Update {
  nextMessageId += 1;
  const mentionSuffix = options.mention !== undefined ? `@${options.mention}` : '';
  const token = `/${command}${mentionSuffix}`;
  const text = args.length > 0 ? `${token} ${args}` : token;
  return {
    update_id: nextUpdateId++,
    message: {
      ...BASE_MESSAGE,
      message_id: nextMessageId,
      from: { ...BASE_MESSAGE.from, id: options.userId ?? MEMBER_ID },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: token.length }],
    },
  } as Update;
}

/* -------------------------------------------------------------------------- */
/* extractCommandInvocation — pure                                            */
/* -------------------------------------------------------------------------- */

describe('extractCommandInvocation', () => {
  it('requires a bot_command entity at offset 0', () => {
    const message: TelegramMessage = { ...BASE_MESSAGE, text: '/tldr -50', entities: undefined };
    expect(extractCommandInvocation(message, BOT_USERNAME)).toBeNull();
  });

  it('ignores a command entity that is not at offset 0', () => {
    const text = 'hej /tldr -50';
    const message: TelegramMessage = {
      ...BASE_MESSAGE,
      text,
      entities: [{ type: 'bot_command', offset: 4, length: 5 }],
    };
    expect(extractCommandInvocation(message, BOT_USERNAME)).toBeNull();
  });

  it('extracts the name and the raw argument string', () => {
    const message: TelegramMessage = {
      ...BASE_MESSAGE,
      text: '/tldr -50 co ustalili?',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    };
    const extracted = extractCommandInvocation(message, BOT_USERNAME);
    expect(extracted).toEqual({ name: 'tldr', rawArgs: '-50 co ustalili?' });
  });

  it('strips a matching @botname suffix', () => {
    const token = `/tldr@${BOT_USERNAME}`;
    const message: TelegramMessage = {
      ...BASE_MESSAGE,
      text: `${token} -50`,
      entities: [{ type: 'bot_command', offset: 0, length: token.length }],
    };
    expect(extractCommandInvocation(message, BOT_USERNAME)).toEqual({ name: 'tldr', rawArgs: '-50' });
  });

  it('ignores a command addressed to a different bot', () => {
    const token = '/tldr@some_other_bot';
    const message: TelegramMessage = {
      ...BASE_MESSAGE,
      text: `${token} -50`,
      entities: [{ type: 'bot_command', offset: 0, length: token.length }],
    };
    expect(extractCommandInvocation(message, BOT_USERNAME)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Only an explicit command triggers the bot                                  */
/* -------------------------------------------------------------------------- */

describe('CommandDispatcher — only an explicit command triggers the bot', () => {
  it('produces zero invocations across 100 ordinary messages', async () => {
    const env = makeEnvironment();
    const ordinaryTexts: string[] = [
      '-5 stopni jutro',
      'since yesterday',
      'co ustalili wczoraj?',
      'wczoraj było zimno',
      '/nottldr -50',
      '/tldr2 -50',
      'tldr -50',
      '2h',
      '-2h',
      'all',
      'hej, czy ktoś widział build?',
      'dzięki wszystkim!',
      '50',
      '2026-09-15 coś tam',
      'a co jeśli /tldr nie jest na początku wiadomości /tldr -50',
    ];
    while (ordinaryTexts.length < 100) {
      ordinaryTexts.push(`wiadomość numer ${String(ordinaryTexts.length)} bez komendy`);
    }
    expect(ordinaryTexts).toHaveLength(100);

    for (const text of ordinaryTexts) {
      const outcome = await env.dispatcher.dispatch(plainMessageUpdate(text));
      expect(outcome.kind).toBe('ignored');
    }

    expect(env.gateway.sent).toHaveLength(0);
    expect(env.summarizeRange.calls).toHaveLength(0);
    expect(env.answerQuestion.calls).toHaveLength(0);
    expect(env.forgetUser.calls).toHaveLength(0);
    expect(env.purgeChat.calls).toHaveLength(0);
    expect(env.updateChatSetting.calls).toHaveLength(0);
    expect(env.readUsage.calls).toHaveLength(0);
  });

  it('ignores updates with no message at all', async () => {
    const env = makeEnvironment();
    const outcome = await env.dispatcher.dispatch({ update_id: 1 } as Update);
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not_a_message' });
  });

  it('ignores a command from a chat that is not on the allowlist', async () => {
    const env = makeEnvironment();
    const outsideChat = asChatId(-1009999999);
    const outcome = await env.dispatcher.dispatch({
      update_id: nextUpdateId++,
      message: {
        ...BASE_MESSAGE,
        chat: { id: outsideChat, type: 'supergroup', title: 'Outside' },
        text: '/tldr -50',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    } as Update);
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not_allowlisted' });
    expect(env.summarizeRange.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Tier matrix, end to end                                                    */
/* -------------------------------------------------------------------------- */

interface TierCase {
  readonly userId: number;
  readonly tier: 'member' | 'chatAdmin' | 'operator';
}

function tierCases(): TierCase[] {
  return [
    { userId: MEMBER_ID, tier: 'member' },
    { userId: CHAT_ADMIN_ID, tier: 'chatAdmin' },
    { userId: OPERATOR_ID, tier: 'operator' },
  ];
}

describe('CommandDispatcher — tier matrix', () => {
  it('member and chatAdmin can run /forgetme, /privacy, /tldr, /tldr dm; only chatAdmin+ can run /forget, /tldr tz, /tldr model, /tldr stats', async () => {
    const env = makeEnvironment();
    for (const { userId, tier } of tierCases()) {
      const forgetMe = await env.dispatcher.dispatch(commandUpdate('forgetme', '', { userId }));
      expect(forgetMe).toMatchObject({ kind: 'handled', command: 'forgetme' });

      const privacy = await env.dispatcher.dispatch(commandUpdate('privacy', '', { userId }));
      expect(privacy).toMatchObject({ kind: 'handled', command: 'privacy' });

      const dm = await env.dispatcher.dispatch(commandUpdate('tldr', 'dm on', { userId }));
      expect(dm).toMatchObject({ kind: 'handled', command: 'dm' });

      const forget = await env.dispatcher.dispatch(commandUpdate('forget', '', { userId }));
      const tz = await env.dispatcher.dispatch(commandUpdate('tldr', 'tz Europe/Warsaw', { userId }));
      const model = await env.dispatcher.dispatch(commandUpdate('tldr', 'model haiku', { userId }));
      const stats = await env.dispatcher.dispatch(commandUpdate('tldr', 'stats', { userId }));

      if (tier === 'member') {
        expect(forget).toMatchObject({ kind: 'denied', command: 'forget', requiredTier: 'chatAdmin' });
        expect(tz).toMatchObject({ kind: 'denied', command: 'tz', requiredTier: 'chatAdmin' });
        expect(model).toMatchObject({ kind: 'denied', command: 'model', requiredTier: 'chatAdmin' });
        expect(stats).toMatchObject({ kind: 'denied', command: 'stats', requiredTier: 'chatAdmin' });
      } else {
        expect(forget).toMatchObject({ kind: 'handled', command: 'forget' });
        expect(tz).toMatchObject({ kind: 'handled', command: 'tz' });
        expect(model).toMatchObject({ kind: 'handled', command: 'model' });
        expect(stats).toMatchObject({ kind: 'handled', command: 'stats' });
      }
    }
  });

  it('only operator can run /tldr stats global, even for a chat admin', async () => {
    const env = makeEnvironment();
    const asChatAdmin = await env.dispatcher.dispatch(commandUpdate('tldr', 'stats global', { userId: CHAT_ADMIN_ID }));
    expect(asChatAdmin).toMatchObject({ kind: 'denied', command: 'stats', requiredTier: 'operator', actualTier: 'chatAdmin' });
    expect(env.readUsage.calls).toHaveLength(0);

    const asOperator = await env.dispatcher.dispatch(commandUpdate('tldr', 'stats global', { userId: OPERATOR_ID }));
    expect(asOperator).toMatchObject({ kind: 'handled', command: 'stats' });
    expect(env.readUsage.calls).toHaveLength(1);
    expect(env.readUsage.calls[0]?.scope).toEqual({ kind: 'global' });
  });

  it('only operator can run /tldr config', async () => {
    const env = makeEnvironment();
    const asMember = await env.dispatcher.dispatch(commandUpdate('tldr', 'config bot.commandName', { userId: MEMBER_ID }));
    expect(asMember).toMatchObject({ kind: 'denied', command: 'config', requiredTier: 'operator' });

    const asChatAdmin = await env.dispatcher.dispatch(
      commandUpdate('tldr', 'config bot.commandName', { userId: CHAT_ADMIN_ID }),
    );
    expect(asChatAdmin).toMatchObject({ kind: 'denied', command: 'config', requiredTier: 'operator' });

    const asOperator = await env.dispatcher.dispatch(
      commandUpdate('tldr', 'config bot.commandName', { userId: OPERATOR_ID }),
    );
    expect(asOperator).toMatchObject({ kind: 'handled', command: 'config' });
    expect(env.gateway.textsFor(HOME_CHAT).at(-1)).toContain('tldr');
  });

  it('sends a permission-denied reply, not silence, on denial', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('forget', '', { userId: MEMBER_ID }));
    expect(env.gateway.sent).toHaveLength(1);
    expect(env.purgeChat.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Individual commands                                                        */
/* -------------------------------------------------------------------------- */

describe('CommandDispatcher — /forgetme', () => {
  it('erases only the invoker, never another user', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('forgetme', '', { userId: MEMBER_ID }));
    expect(env.forgetUser.calls).toHaveLength(1);
    const call = env.forgetUser.calls[0];
    expect(call?.userId).toBe(asUserId(MEMBER_ID));
    expect(call?.requestedBy).toBe(asUserId(MEMBER_ID));
    expect(call?.chatId).toBe(HOME_CHAT);
  });
});

describe('CommandDispatcher — /forget', () => {
  it('wipes the chat as a chat admin', async () => {
    const env = makeEnvironment();
    const outcome = await env.dispatcher.dispatch(commandUpdate('forget', '', { userId: CHAT_ADMIN_ID }));
    expect(outcome).toMatchObject({ kind: 'handled', command: 'forget' });
    expect(env.purgeChat.calls).toHaveLength(1);
    expect(env.purgeChat.calls[0]?.chatId).toBe(HOME_CHAT);
  });
});

describe('CommandDispatcher — /tldr tz', () => {
  it('rejects an invalid IANA zone without writing', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'tz Not/AZone', { userId: CHAT_ADMIN_ID }));
    expect(env.updateChatSetting.calls).toHaveLength(0);
    expect(env.gateway.sent.at(-1)?.params.text).toContain('Not/AZone');
  });

  it('accepts a valid IANA zone and writes it', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'tz Europe/Warsaw', { userId: CHAT_ADMIN_ID }));
    expect(env.updateChatSetting.calls).toHaveLength(1);
    expect(env.updateChatSetting.calls[0]?.change).toEqual({ kind: 'timeZone', timeZone: 'Europe/Warsaw' });
  });
});

describe('CommandDispatcher — /tldr model', () => {
  it('rejects an unknown alias', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'model gpt-nope', { userId: CHAT_ADMIN_ID }));
    expect(env.updateChatSetting.calls).toHaveLength(0);
  });

  it('accepts a registered alias', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'model haiku', { userId: CHAT_ADMIN_ID }));
    expect(env.updateChatSetting.calls).toHaveLength(1);
    expect(env.updateChatSetting.calls[0]?.change).toEqual({ kind: 'model', alias: 'haiku' });
  });
});

describe('CommandDispatcher — /tldr dm', () => {
  it('sets the invoker-only dm preference, on and off', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'dm on', { userId: MEMBER_ID }));
    expect(env.updateChatSetting.calls[0]?.change).toEqual({ kind: 'dmDelivery', enabled: true });
    expect(env.updateChatSetting.calls[0]?.requestedBy).toBe(asUserId(MEMBER_ID));

    await env.dispatcher.dispatch(commandUpdate('tldr', 'dm off', { userId: MEMBER_ID }));
    expect(env.updateChatSetting.calls[1]?.change).toEqual({ kind: 'dmDelivery', enabled: false });
  });

  it('replies with usage on a bad argument, without writing', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'dm maybe', { userId: MEMBER_ID }));
    expect(env.updateChatSetting.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Range / question routing                                                   */
/* -------------------------------------------------------------------------- */

describe('CommandDispatcher — /tldr range and question routing', () => {
  it('routes a bare range to SummarizeRange', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', '-50'));
    expect(env.summarizeRange.calls).toHaveLength(1);
    expect(env.answerQuestion.calls).toHaveLength(0);
    expect(env.summarizeRange.calls[0]?.parsed.rangeSpec).toMatchObject({ kind: 'messageCount', count: 50 });
  });

  it('routes a range with a trailing question to AnswerQuestion', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', '-50 co ustalili?'));
    expect(env.answerQuestion.calls).toHaveLength(1);
    expect(env.summarizeRange.calls).toHaveLength(0);
    expect(env.answerQuestion.calls[0]?.question).toBe('co ustalili?');
  });

  it('routes a bare default invocation (no leading range token) to SummarizeRange', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', ''));
    expect(env.summarizeRange.calls).toHaveLength(1);
    expect(env.summarizeRange.calls[0]?.parsed.rangeSpec.kind).toBe('default');
  });

  it('replies with a help hint on a bare positive number (missing unit) instead of guessing', async () => {
    const env = makeEnvironment();
    const outcome = await env.dispatcher.dispatch(commandUpdate('tldr', '50'));
    expect(outcome).toMatchObject({ kind: 'handled', command: 'tldr', result: { kind: 'replied' } });
    expect(env.summarizeRange.calls).toHaveLength(0);
    expect(env.answerQuestion.calls).toHaveLength(0);
    expect(env.gateway.sent.at(-1)?.params.text).toContain('help');
  });

  it('sends a reply when the outcome is refused', async () => {
    const env = makeEnvironment();
    env.summarizeRange.outcome = { kind: 'refused', code: 'guard.cooldown', retryAfterSeconds: 42 };
    await env.dispatcher.dispatch(commandUpdate('tldr', '-50'));
    expect(env.gateway.sent.at(-1)?.params.text).toContain('42');
  });

  it('does not reply itself when the outcome is answered (the use case already delivered it)', async () => {
    const env = makeEnvironment();
    env.summarizeRange.outcome = {
      kind: 'answered',
      delivered: {
        answer: {
          content: { summary: 's', keyPoints: [], unanswered: [], tone: 'neutral' },
          meta: {
            chatId: HOME_CHAT,
            scope: { kind: 'thread', threadId: null },
            topicLabel: null,
            range: {
              scope: { kind: 'thread', threadId: null },
              start: { kind: 'lastN', count: 50 },
              end: env.clock.now(),
              limit: 50,
              spec: { kind: 'messageCount', raw: '-50', count: 50 },
              basis: 'explicit',
              clampedToHorizon: false,
              timeZone: 'Europe/Warsaw',
            },
            spec: { kind: 'messageCount', raw: '-50', count: 50 },
            messageCount: 50,
            gapCount: 0,
            cached: null,
            model: 'claude-sonnet-5',
            promptVersion: 'v1',
          },
        },
        delivery: 'in_chat',
        threadId: null,
        messageIds: [],
      },
    };
    await env.dispatcher.dispatch(commandUpdate('tldr', '-50'));
    // The command handler itself sent nothing — SummarizeRange already delivered.
    expect(env.gateway.sent).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Subcommand keyword matching is whole-word and leading-only                 */
/* -------------------------------------------------------------------------- */

describe('CommandDispatcher — subcommand keywords are matched as a whole leading word only', () => {
  it('does not treat "stats" mid-question as the stats subcommand', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'co ustalono w kwestii stats?'));
    expect(env.readUsage.calls).toHaveLength(0);
    expect(env.answerQuestion.calls).toHaveLength(1);
  });

  it('does not treat "helper" as the help subcommand', async () => {
    const env = makeEnvironment();
    await env.dispatcher.dispatch(commandUpdate('tldr', 'helper wanted'));
    expect(env.summarizeRange.calls).toHaveLength(0);
    expect(env.answerQuestion.calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Unexpected failures still get a reply, and get reported                    */
/* -------------------------------------------------------------------------- */

describe('CommandDispatcher — unexpected failures', () => {
  it('reports the error and replies rather than throwing out of dispatch()', async () => {
    const env = makeEnvironment();
    env.summarizeRange.execute = () => {
      throw new Error('boom');
    };
    const outcome = await env.dispatcher.dispatch(commandUpdate('tldr', '-50'));
    expect(outcome).toMatchObject({ kind: 'failed', command: 'tldr' });
    expect(env.reporter.events).toHaveLength(1);
    expect(env.gateway.sent).toHaveLength(1);
  });
});
