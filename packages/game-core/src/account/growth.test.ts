import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_GROWTH_RULES,
  ACCOUNT_GROWTH_RULE_IDS,
  OFFLINE_RULES,
  SLOT_RULES,
  accountGrowthEarned,
  offlineCapEndMs,
  offlineCapMs,
} from './growth.js';

const H = 3_600_000;
const BASE = 3 * H;

describe('account growth rules (ticket 9.4)', () => {
  it('has unique ids, three slot rules and four offline deeds', () => {
    expect(new Set(ACCOUNT_GROWTH_RULE_IDS).size).toBe(ACCOUNT_GROWTH_RULES.length);
    expect(SLOT_RULES.map((r) => r.id)).toEqual(['level28', 'heroicCrypt', 'community']);
    expect(OFFLINE_RULES).toHaveLength(4);
  });

  it('steps the offline cap 3 → 4 → 5 → 6 → 8 hours and no further', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => offlineCapMs(BASE, n) / H)).toEqual([
      3, 4, 5, 6, 8, 8, 8,
    ]);
  });

  it('reads slot and offline unlocks from one hero', () => {
    expect(accountGrowthEarned({ level: 9, progress: {} })).toEqual([]);
    expect(accountGrowthEarned({ level: 10, progress: {} })).toEqual(['offlineLevel10']);
    expect(accountGrowthEarned({ level: 28, progress: { gravewardenDefeated: true } })).toEqual([
      'level28',
      'offlineLevel10',
      'offlineCrypt1',
    ]);
    expect(
      accountGrowthEarned({
        level: 40,
        progress: { gravewardenDefeated: true, cryptTierCleared: 4, ashenWardenDefeated: true },
      }),
    ).toEqual([
      'level28',
      'heroicCrypt',
      'offlineLevel10',
      'offlineCrypt1',
      'offlineCrypt3',
      'offlineCinderwastes',
    ]);
  });

  it('never grants the community slot: its project does not exist yet', () => {
    const maxed = {
      level: 999,
      progress: {
        gravewardenDefeated: true,
        cryptTierCleared: 99,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
        hollowSovereignDefeated: true,
      },
    };
    expect(accountGrowthEarned(maxed)).not.toContain('community');
  });
});

describe('offlineCapEndMs (ticket 9.4)', () => {
  const seen = 1_000_000;

  it('is the base cap with no deeds', () => {
    expect(offlineCapEndMs(seen, BASE, [])).toBe(seen + 3 * H);
  });

  it('counts deeds earned before the contact at once', () => {
    expect(offlineCapEndMs(seen, BASE, [0, 10, 20])).toBe(seen + 6 * H);
    expect(offlineCapEndMs(seen, BASE, [0, 1, 2, 3])).toBe(seen + 8 * H);
  });

  it('extends from the moment a deed is earned while the cap still runs', () => {
    expect(offlineCapEndMs(seen, BASE, [seen + H])).toBe(seen + 4 * H);
    // At the edge: earned exactly as the cap runs out still counts.
    expect(offlineCapEndMs(seen, BASE, [seen + 3 * H])).toBe(seen + 4 * H);
  });

  it('never pays back time already lost', () => {
    expect(offlineCapEndMs(seen, BASE, [seen + 3 * H + 1])).toBe(seen + 3 * H);
    // A chain: the second deed lands inside the extension, the third after it ran out.
    expect(offlineCapEndMs(seen, BASE, [seen + 2 * H, seen + 4 * H, seen + 6 * H])).toBe(
      seen + 5 * H,
    );
  });

  it('does not depend on the order the grants are listed in', () => {
    const times = [seen + 4 * H, seen - 5, seen + 2 * H, seen + 9 * H];
    expect(offlineCapEndMs(seen, BASE, times)).toBe(
      offlineCapEndMs(seen, BASE, [...times].reverse()),
    );
    expect(offlineCapEndMs(seen, BASE, times)).toBe(seen + 6 * H);
  });

  it('follows the configured base', () => {
    expect(offlineCapEndMs(seen, H, [0])).toBe(seen + 2 * H);
  });
});
