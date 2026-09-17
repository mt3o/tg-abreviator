/**
 * `ThrottledProgressReporter` (DESIGN §8: "throttled to ~1 edit / 3s").
 */
import { describe, expect, it } from 'vitest';

import { ThrottledProgressReporter } from '../../../src/application/compaction/progress.js';
import { asChatId, asMessageId } from '../../../src/domain/model/ids.js';
import { FakeChatGateway } from '../../fakes/fake-chat-gateway.js';
import { FakeClock } from '../../fakes/fake-clock.js';

const CHAT = asChatId(-1001);
const PLACEHOLDER_MESSAGE = asMessageId(500);
const THROTTLE_MS = 3000;

function makeReporter(gateway: FakeChatGateway, clock: FakeClock): ThrottledProgressReporter {
  return new ThrottledProgressReporter({
    gateway,
    clock,
    target: { chatId: CHAT, messageId: PLACEHOLDER_MESSAGE },
    throttleMs: THROTTLE_MS,
    render: (progress) => `kompaktuję ${String(progress.done)}/${String(progress.total)}`,
  });
}

describe('ThrottledProgressReporter', () => {
  it('always sends the very first report', async () => {
    const gateway = new FakeChatGateway();
    const clock = new FakeClock();
    const reporter = makeReporter(gateway, clock);

    await reporter.report({ phase: 'map', level: 0, done: 1, total: 10 });

    expect(gateway.edits).toHaveLength(1);
    expect(gateway.edits[0]?.params.text).toBe('kompaktuję 1/10');
  });

  it('drops a report that arrives before the throttle window elapses', async () => {
    const gateway = new FakeChatGateway();
    const clock = new FakeClock();
    const reporter = makeReporter(gateway, clock);

    await reporter.report({ phase: 'map', level: 0, done: 1, total: 10 });
    clock.advanceMillis(THROTTLE_MS - 1);
    await reporter.report({ phase: 'map', level: 0, done: 2, total: 10 });

    expect(gateway.edits).toHaveLength(1);
  });

  it('sends again once the throttle window has elapsed', async () => {
    const gateway = new FakeChatGateway();
    const clock = new FakeClock();
    const reporter = makeReporter(gateway, clock);

    await reporter.report({ phase: 'map', level: 0, done: 1, total: 10 });
    clock.advanceMillis(THROTTLE_MS);
    await reporter.report({ phase: 'map', level: 0, done: 2, total: 10 });

    expect(gateway.edits).toHaveLength(2);
    expect(gateway.edits[1]?.params.text).toBe('kompaktuję 2/10');
  });

  it('always sends the completing report (done >= total), even within the throttle window', async () => {
    const gateway = new FakeChatGateway();
    const clock = new FakeClock();
    const reporter = makeReporter(gateway, clock);

    await reporter.report({ phase: 'map', level: 0, done: 1, total: 3 });
    clock.advanceMillis(1);
    await reporter.report({ phase: 'map', level: 0, done: 2, total: 3 });
    clock.advanceMillis(1);
    await reporter.report({ phase: 'map', level: 0, done: 3, total: 3 });

    // First (always) + completing (always) = 2; the middle one was throttled.
    expect(gateway.edits).toHaveLength(2);
    expect(gateway.edits[1]?.params.text).toBe('kompaktuję 3/3');
  });

  it('edits the placeholder message, not a new one', async () => {
    const gateway = new FakeChatGateway();
    const clock = new FakeClock();
    const reporter = makeReporter(gateway, clock);

    await reporter.report({ phase: 'reduce', level: 1, done: 1, total: 1 });

    expect(gateway.edits[0]?.chatId).toBe(CHAT);
    expect(gateway.edits[0]?.messageId).toBe(PLACEHOLDER_MESSAGE);
    expect(gateway.sent).toHaveLength(0);
  });
});
