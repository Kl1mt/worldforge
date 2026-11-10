import { describe, expect, it } from 'vitest';
import { ITEM_BASES, ITEM_SETS, MYTHIC_ITEMS } from '@worldforge/game-core';
import {
  auditLine,
  baseTag,
  basesBySlot,
  cheatAccess,
  confirmMatches,
  describeToolFailure,
  formatLock,
  goldAfter,
  groupByLocation,
  itemProblems,
  materialsAfter,
  parseWhole,
  reasonValid,
  removeBlockedText,
  unlockSummary,
} from './tools-view';
import type { AdminItem } from './tools-api';

const failure = (code: string, details?: unknown, status = 422) => ({
  status,
  code,
  message: 'Server says no.',
  fields: {},
  details,
});

describe('admin inspector helpers (ticket D.4)', () => {
  it('gates the cheat tools on test and own accounts', () => {
    expect(cheatAccess({ testAccount: true, own: false })).toBe('test');
    expect(cheatAccess({ testAccount: true, own: true })).toBe('test');
    expect(cheatAccess({ testAccount: false, own: true })).toBe('own');
    expect(cheatAccess({ testAccount: false, own: false })).toBe('blocked');
  });

  it('checks reasons and typed confirmations like the server', () => {
    expect(reasonValid('ab')).toBe(false);
    expect(reasonValid('  ab  ')).toBe(false);
    expect(reasonValid('bug')).toBe(true);
    expect(reasonValid('x'.repeat(501))).toBe(false);
    expect(confirmMatches('Grimwald', ' grimwald ')).toBe(true);
    expect(confirmMatches('Grimwald', 'Grim')).toBe(false);
    expect(confirmMatches('', '')).toBe(false);
  });

  it('formats the login lock', () => {
    expect(formatLock(0)).toBe('not locked');
    expect(formatLock(-5)).toBe('not locked');
    expect(formatLock(40_000)).toBe('locked for 40 s');
    expect(formatLock(90_000)).toBe('locked for 2 min');
    expect(formatLock(65 * 60_000)).toBe('locked for 1 h 5 min');
    expect(formatLock(120 * 60_000)).toBe('locked for 2 h');
  });

  it('renders audit data as one short line without the actor id', () => {
    expect(
      auditLine({ by: 'acc-1', reason: 'refund', before: { gold: 5 }, after: { gold: 9 } }),
    ).toBe('reason: refund · before: gold: 5 · after: gold: 9');
    expect(auditLine(null)).toBe('–');
    expect(auditLine({ list: [1, 2] })).toBe('list: [1, 2]');
    expect(auditLine({ text: 'x'.repeat(300) }, 20)).toHaveLength(20);
  });

  it('previews gold and material changes', () => {
    expect(goldAfter('grant', 10, 5)).toBe(15);
    expect(goldAfter('refund', 10, 5)).toBe(15);
    expect(goldAfter('remove', 10, 5)).toBe(5);
    expect(goldAfter('remove', 4, 5)).toBeNull();
    expect(goldAfter('grant', 4, 0)).toBeNull();
    expect(materialsAfter('grant', { timber: 2 }, { timber: 3, ironOre: 1 })).toEqual({
      timber: 5,
      ironOre: 1,
    });
    expect(materialsAfter('remove', { timber: 2 }, { timber: 2 })).toEqual({ timber: 0 });
    expect(materialsAfter('remove', { timber: 2 }, { timber: 3 })).toBeNull();
    expect(parseWhole('1,000')).toBe(1000);
    expect(parseWhole('12a')).toBeNull();
    expect(parseWhole('')).toBeNull();
  });

  it('explains tool failures, with the problems of an invalid item', () => {
    const invalid = failure('invalid_item', { problems: ['Item level too low.'] });
    expect(itemProblems(invalid)).toEqual(['Item level too low.']);
    expect(describeToolFailure(invalid)).toMatch(/Item level too low/);
    expect(itemProblems(failure('inventory_full'))).toEqual([]);
    expect(describeToolFailure(failure('confirmation_mismatch', { expected: 'Grim' }))).toMatch(
      /“Grim”/,
    );
    expect(describeToolFailure(failure('test_account_required', undefined, 403))).toMatch(
      /test-account/,
    );
    expect(describeToolFailure(failure('item_held', undefined, 409))).toBe('Server says no.');
  });

  it('groups items by location and explains blocked removals', () => {
    const item = (id: string, location: AdminItem['location']) =>
      ({ id, location, removeBlocked: null }) as AdminItem;
    const groups = groupByLocation([item('a', 'pack'), item('b', 'equipped'), item('c', 'pack')]);
    expect(groups.map((g) => [g.location, g.items.map((i) => i.id)])).toEqual([
      ['equipped', ['b']],
      ['pack', ['a', 'c']],
    ]);
    expect(removeBlockedText({ removeBlocked: null })).toBeNull();
    expect(removeBlockedText({ removeBlocked: 'escrow' })).toMatch(/trade offer/);
    expect(removeBlockedText({ removeBlocked: 'held', holdUntil: '2026-03-12T14:05:00Z' })).toMatch(
      /^Held after a trade until /,
    );
  });

  it('labels set and mythic bases and lists every base once', () => {
    const set = ITEM_SETS[0]!;
    expect(baseTag(ITEM_BASES.find((b) => b.id === set.pieces[0])!)).toBe(`Set: ${set.name}`);
    expect(baseTag(ITEM_BASES.find((b) => b.id === MYTHIC_ITEMS[0]!.baseId)!)).toBe('Mythic');
    const listed = basesBySlot().flatMap((g) => g.bases.map((b) => b.id));
    expect(new Set(listed).size).toBe(ITEM_BASES.length);
  });

  it('summarises unlocks from level and progress', () => {
    const none = { gravewardenDefeated: false };
    const fresh = unlockSummary(1, none);
    expect(fresh[0]!.missing).toEqual([]);
    expect(fresh.some((p) => p.missing.includes('needs the Gravewarden defeated'))).toBe(true);
    const done = unlockSummary(60, {
      gravewardenDefeated: true,
      cryptTierCleared: 3,
      ashenWardenDefeated: true,
    });
    expect(done.every((p) => p.missing.length === 0)).toBe(true);
  });
});
