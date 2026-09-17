import { describe, expect, it } from 'vitest';

import { CooldownGuard } from '../../../src/application/guards/cooldown-guard.js';
import { CooldownError } from '../../../src/domain/errors.js';
import { asChatId, asUserId } from '../../../src/domain/model/ids.js';
import { DEFAULT_FAKE_NOW, FakeClock } from '../../fakes/fake-clock.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const USER_ID = asUserId(111);
const OTHER_USER_ID = asUserId(222);
const OTHER_CHAT_ID = asChatId(-2);

describe('CooldownGuard', () => {
  it('allows the first call from a user', () => {
    const guard = new CooldownGuard(new FakeClock());
    expect(() => guard.check(CHAT_ID, USER_ID, 60)).not.toThrow();
  });

  it('rejects a second call inside the cooldown window with the remaining seconds', () => {
    const clock = new FakeClock();
    const guard = new CooldownGuard(clock);
    guard.check(CHAT_ID, USER_ID, 60);

    clock.advance({ seconds: 10 });
    expect(() => guard.check(CHAT_ID, USER_ID, 60)).toThrow(CooldownError);
    try {
      guard.check(CHAT_ID, USER_ID, 60);
      expect.unreachable('expected CooldownError');
    } catch (error) {
      expect(error).toBeInstanceOf(CooldownError);
      expect((error as CooldownError).retryAfterSeconds).toBe(50);
    }
  });

  it('allows a call once exactly cooldownSeconds have elapsed', () => {
    const clock = new FakeClock();
    const guard = new CooldownGuard(clock);
    guard.check(CHAT_ID, USER_ID, 60);
    clock.advance({ seconds: 60 });
    expect(() => guard.check(CHAT_ID, USER_ID, 60)).not.toThrow();
  });

  it('allows a call after cooldownSeconds have fully elapsed', () => {
    const clock = new FakeClock();
    const guard = new CooldownGuard(clock);
    guard.check(CHAT_ID, USER_ID, 60);
    clock.advance({ seconds: 61 });
    expect(() => guard.check(CHAT_ID, USER_ID, 60)).not.toThrow();
  });

  it('tracks cooldowns independently per user', () => {
    const guard = new CooldownGuard(new FakeClock());
    guard.check(CHAT_ID, USER_ID, 60);
    expect(() => guard.check(CHAT_ID, OTHER_USER_ID, 60)).not.toThrow();
  });

  it('tracks cooldowns independently per chat for the same user', () => {
    const guard = new CooldownGuard(new FakeClock());
    guard.check(CHAT_ID, USER_ID, 60);
    expect(() => guard.check(OTHER_CHAT_ID, USER_ID, 60)).not.toThrow();
  });

  it('resets forgotten cooldowns', () => {
    const guard = new CooldownGuard(new FakeClock());
    guard.check(CHAT_ID, USER_ID, 60);
    guard.reset();
    expect(() => guard.check(CHAT_ID, USER_ID, 60)).not.toThrow();
  });

  it('uses the clock port, not real time', () => {
    const clock = new FakeClock(DEFAULT_FAKE_NOW);
    const guard = new CooldownGuard(clock);
    guard.check(CHAT_ID, USER_ID, 60);
    expect(() => guard.check(CHAT_ID, USER_ID, 60)).toThrow(CooldownError);
  });
});
