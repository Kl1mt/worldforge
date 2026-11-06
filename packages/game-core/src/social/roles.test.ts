import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ROLES,
  MODERATION_ACTIONS,
  actionableRoles,
  moderationDecision,
  type AccountRole,
  type ModerationDecision,
} from './roles.js';
import { blockingSanction } from './sanctions.js';
import { HANDLE_RE, handleFromBytes } from './reports.js';

describe('moderationDecision', () => {
  type Subject = 'none' | 'self' | AccountRole;
  const subjects: Subject[] = ['none', 'self', 'player', 'moderator', 'admin'];
  // Written out by hand (not derived) so a change to the rules has to change this table.
  const expected: Record<AccountRole, Record<Subject, ModerationDecision>> = {
    player: {
      none: 'not_found',
      self: 'not_found',
      player: 'not_found',
      moderator: 'not_found',
      admin: 'not_found',
    },
    moderator: {
      none: 'forbidden',
      self: 'forbidden',
      player: 'allowed',
      moderator: 'forbidden',
      admin: 'forbidden',
    },
    admin: {
      none: 'forbidden',
      self: 'forbidden',
      player: 'allowed',
      moderator: 'allowed',
      admin: 'forbidden',
    },
  };

  for (const actor of ACCOUNT_ROLES) {
    for (const action of MODERATION_ACTIONS) {
      for (const s of subjects) {
        it(`${actor} → ${action} on ${s}`, () => {
          const subject =
            s === 'none'
              ? undefined
              : s === 'self'
                ? { self: true, role: actor }
                : { self: false, role: s };
          const want =
            action === 'viewQueue'
              ? actor === 'player'
                ? 'not_found'
                : 'allowed'
              : expected[actor][s];
          expect(moderationDecision(actor, action, subject)).toBe(want);
        });
      }
    }
  }

  it('filters the queue to roles below the actor', () => {
    expect(actionableRoles('player')).toEqual([]);
    expect(actionableRoles('moderator')).toEqual(['player']);
    expect(actionableRoles('admin')).toEqual(['player', 'moderator']);
  });
});

describe('blockingSanction', () => {
  const mute = { kind: 'mute' as const };
  const suspend = { kind: 'suspend' as const };
  it('a suspension blocks everything; a mute blocks all but reports and the forced rename', () => {
    expect(blockingSanction([mute], 'chat')).toBe(mute);
    expect(blockingSanction([mute], 'report')).toBeNull();
    expect(blockingSanction([mute], 'rename')).toBeNull();
    expect(blockingSanction([mute, suspend], 'report')).toBe(suspend);
    expect(blockingSanction([{ kind: 'hide' as const }], 'chat')).toBeNull();
  });
});

describe('handles', () => {
  it('maps random bytes onto the alphabet', () => {
    const h = handleFromBytes(Array.from({ length: 12 }, (_, i) => i * 37));
    expect(h).toMatch(HANDLE_RE);
    expect(() => handleFromBytes([1, 2])).toThrow();
  });
});
