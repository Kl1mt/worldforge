import { describe, expect, it } from 'vitest';
import {
  FRIEND_ACTIONS,
  FRIEND_MATRIX,
  PRESENCE_ONLINE_MS,
  PRESENCE_WRITE_INTERVAL_MS,
  RELATIONS,
  friendDecision,
  presenceBucket,
  relationFromFacts,
  visibleRelation,
} from './relations.js';
import { blockingSanction } from './sanctions.js';

const facts = { blockedByMe: false, blockedByThem: false, friendship: null };

describe('relations (ticket 4.3)', () => {
  it('derives the relation from the facts; blocks win, the viewer’s own block first', () => {
    expect(relationFromFacts({ ...facts, self: true, blockedByMe: true })).toBe('self');
    expect(relationFromFacts(facts)).toBe('stranger');
    const pending = { status: 'pending' as const, requestedByMe: true };
    expect(relationFromFacts({ ...facts, friendship: pending })).toBe('requested-by-me');
    expect(relationFromFacts({ ...facts, friendship: { ...pending, requestedByMe: false } })).toBe(
      'requested-by-them',
    );
    const friends = { status: 'friends' as const, requestedByMe: false };
    expect(relationFromFacts({ ...facts, friendship: friends })).toBe('friend');
    expect(relationFromFacts({ ...facts, friendship: friends, blockedByThem: true })).toBe(
      'blocked-by-them',
    );
    expect(relationFromFacts({ ...facts, blockedByThem: true, blockedByMe: true })).toBe(
      'blocked-by-me',
    );
  });

  it('every relation × action has a decision; a blocker is never revealed', () => {
    for (const action of FRIEND_ACTIONS) {
      for (const rel of RELATIONS) {
        const d = friendDecision(rel, action);
        expect(d, `${action}/${rel}`).toBeTruthy();
        if (rel === 'blocked-by-them' && d !== 'allowed') {
          expect(d.status).toBe(404);
        }
      }
      // Only blocking back and reporting are allowed against a player who blocks you.
      expect(FRIEND_MATRIX[action]['blocked-by-them'] === 'allowed').toBe(
        action === 'block' || action === 'report',
      );
    }
    expect(visibleRelation('blocked-by-them')).toBeNull();
    expect(visibleRelation('blocked-by-me')).toBe('blocked-by-me');
  });

  it('presence buckets: online covers more than one write interval', () => {
    expect(PRESENCE_ONLINE_MS).toBeGreaterThan(2 * PRESENCE_WRITE_INTERVAL_MS);
    const now = new Date('2026-11-06T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const MIN = 60_000;
    const DAY = 1440 * MIN;
    expect(presenceBucket(null, now)).toBe('longer');
    expect(presenceBucket(ago(0), now)).toBe('online');
    expect(presenceBucket(ago(10 * MIN), now)).toBe('online');
    expect(presenceBucket(ago(10 * MIN + 1), now)).toBe('today');
    expect(presenceBucket(ago(DAY), now)).toBe('today');
    expect(presenceBucket(ago(DAY + 1), now)).toBe('week');
    expect(presenceBucket(ago(7 * DAY), now)).toBe('week');
    expect(presenceBucket(ago(7 * DAY + 1), now)).toBe('longer');
  });

  it('a mute blocks sending and accepting, not stepping away', () => {
    const mute = [{ kind: 'mute' as const }];
    for (const a of ['friendRequest', 'friendAccept'])
      expect(blockingSanction(mute, a)).toBeTruthy();
    for (const a of ['friendDecline', 'friendCancel', 'friendRemove', 'block', 'unblock']) {
      expect(blockingSanction(mute, a), a).toBeNull();
    }
  });
});
