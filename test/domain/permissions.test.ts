/**
 * Tier matrix (DESIGN §2, PLAN WS6 DoD): every command × every tier,
 * allow/deny — plus the small predicates the dispatcher builds it from.
 */
import { describe, expect, it } from 'vitest';

import { PermissionDeniedError } from '../../src/domain/errors.js';
import { asUserId } from '../../src/domain/model/ids.js';
import { TIER_RANK } from '../../src/domain/model/tier.js';
import type { Tier } from '../../src/domain/model/tier.js';
import {
  COMMAND_TIERS,
  hasTier,
  isOperator,
  requireTier,
  tierFromChatMemberStatus,
} from '../../src/domain/permissions.js';
import type { CommandName } from '../../src/domain/permissions.js';

const TIERS: readonly Tier[] = ['member', 'chatAdmin', 'operator'];
const COMMANDS = Object.keys(COMMAND_TIERS) as CommandName[];

describe('COMMAND_TIERS matrix — every command × every tier', () => {
  for (const command of COMMANDS) {
    const required = COMMAND_TIERS[command];
    for (const actual of TIERS) {
      const shouldAllow = TIER_RANK[actual] >= TIER_RANK[required];
      it(`${command} (requires ${required}) × ${actual} -> ${shouldAllow ? 'allow' : 'deny'}`, () => {
        expect(hasTier(actual, required)).toBe(shouldAllow);
        if (shouldAllow) {
          expect(() => requireTier(actual, required)).not.toThrow();
        } else {
          expect(() => requireTier(actual, required)).toThrow(PermissionDeniedError);
        }
      });
    }
  }
});

describe('requireTier', () => {
  it('throws PermissionDeniedError carrying both tiers', () => {
    try {
      requireTier('member', 'chatAdmin');
      expect.unreachable('requireTier should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      const denied = error as PermissionDeniedError;
      expect(denied.requiredTier).toBe('chatAdmin');
      expect(denied.actualTier).toBe('member');
      expect(denied.code).toBe('permission.denied');
      expect(denied.report).toBe(false);
    }
  });

  it('operator satisfies every required tier', () => {
    for (const required of TIERS) {
      expect(() => requireTier('operator', required)).not.toThrow();
    }
  });
});

describe('tierFromChatMemberStatus', () => {
  it('maps creator and administrator to chatAdmin', () => {
    expect(tierFromChatMemberStatus('creator')).toBe('chatAdmin');
    expect(tierFromChatMemberStatus('administrator')).toBe('chatAdmin');
  });

  it('maps every other status to member', () => {
    expect(tierFromChatMemberStatus('member')).toBe('member');
    expect(tierFromChatMemberStatus('restricted')).toBe('member');
    expect(tierFromChatMemberStatus('left')).toBe('member');
    expect(tierFromChatMemberStatus('kicked')).toBe('member');
  });
});

describe('isOperator', () => {
  it('is true only for ids in the operator list', () => {
    const operators = [asUserId(1), asUserId(2)];
    expect(isOperator(asUserId(1), operators)).toBe(true);
    expect(isOperator(asUserId(3), operators)).toBe(false);
    expect(isOperator(asUserId(1), [])).toBe(false);
  });
});
