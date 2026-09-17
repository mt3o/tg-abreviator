import { describe, expect, it } from 'vitest';

import { ConcurrencyGuard } from './concurrency-guard.js';
import { ConcurrentRequestError } from '../../domain/errors.js';
import { asChatId } from '../../domain/model/ids.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const OTHER_CHAT_ID = asChatId(-2);

describe('ConcurrencyGuard', () => {
  it('allows the first in-flight call for a chat', () => {
    const guard = new ConcurrencyGuard();
    expect(() => guard.acquire(CHAT_ID, 1)).not.toThrow();
    expect(guard.inFlightCount(CHAT_ID)).toBe(1);
  });

  it('rejects a second concurrent call at limit 1, preventing two map-reduce jobs racing', () => {
    const guard = new ConcurrencyGuard();
    guard.acquire(CHAT_ID, 1);
    expect(() => guard.acquire(CHAT_ID, 1)).toThrow(ConcurrentRequestError);
  });

  it('allows a new call after the in-flight one releases', () => {
    const guard = new ConcurrencyGuard();
    guard.acquire(CHAT_ID, 1);
    guard.release(CHAT_ID);
    expect(() => guard.acquire(CHAT_ID, 1)).not.toThrow();
  });

  it('honours a configured limit above 1', () => {
    const guard = new ConcurrencyGuard();
    guard.acquire(CHAT_ID, 2);
    guard.acquire(CHAT_ID, 2);
    expect(() => guard.acquire(CHAT_ID, 2)).toThrow(ConcurrentRequestError);
  });

  it('tracks concurrency independently per chat', () => {
    const guard = new ConcurrencyGuard();
    guard.acquire(CHAT_ID, 1);
    expect(() => guard.acquire(OTHER_CHAT_ID, 1)).not.toThrow();
  });

  it('release is a no-op past zero rather than going negative', () => {
    const guard = new ConcurrencyGuard();
    guard.release(CHAT_ID);
    expect(guard.inFlightCount(CHAT_ID)).toBe(0);
    expect(() => guard.acquire(CHAT_ID, 1)).not.toThrow();
  });

  it('decrements rather than fully releasing when more than one call remains in flight', () => {
    const guard = new ConcurrencyGuard();
    guard.acquire(CHAT_ID, 2);
    guard.acquire(CHAT_ID, 2);
    guard.release(CHAT_ID);
    expect(guard.inFlightCount(CHAT_ID)).toBe(1);
    expect(() => guard.acquire(CHAT_ID, 2)).not.toThrow();
    expect(() => guard.acquire(CHAT_ID, 2)).toThrow(ConcurrentRequestError);
  });
});
