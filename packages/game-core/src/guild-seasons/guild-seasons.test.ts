import { describe, expect, it } from 'vitest';
import {
  GUILD_SEASON_FORMULA_VERSION,
  compareGuildEntries,
  guildSeasonScore,
  memberCommunityPoints,
  memberPvePoints,
  type GuildSeasonInput,
} from './formula.js';
import { GUILD_SEASON_RULES, giftDayCounts, memberCounts, memberHonourEligible } from './rules.js';
import {
  guildHonourTierFor,
  guildSeasonAwards,
  guildTierLastPlace,
  GUILD_HONOUR_TIERS,
} from './honours.js';
import { COSMETICS, guildSeasonCosmeticsEarned } from '../cosmetics/catalogue.js';
import { createRng } from '../rng.js';

/** Ticket 8.4: the guild season formula, churn rules and honours (docs/LEADERBOARDS.md). */

const member = (pve: number | null, gifts: GuildSeasonInput['members'][number]['gifts'] = []) => ({
  pve: pve === null ? null : { value: pve, of: 25 },
  gifts,
});

const sample: GuildSeasonInput = {
  stages: [1, 2, 3, 1, 2, 1],
  members: [
    member(25, [
      { projectId: 'deepLanterns', stageId: 'lanternPosts', resource: 'gold', amount: 9_000 },
    ]),
    member(20),
    member(10, [
      { projectId: 'deepLanterns', stageId: 'lanternPosts', resource: 'ironOre', amount: 120 },
      { projectId: 'deepLanterns', stageId: 'lanternPosts', resource: 'soulShard', amount: 50 },
    ]),
  ],
};

describe('the guild season formula (version 1)', () => {
  it('is pinned', () => {
    const s = guildSeasonScore(sample);
    // Stages 20+40+60+20+40+20 = 200; PvE 100+80+40; works 10 (a tenth of 90,000) + 10 + 10.
    expect(s).toEqual({
      formulaVersion: 1,
      value: 200 + 220 + 30,
      sortKey: [450, 200, 220, 30],
      parts: { boss: 200, pve: 220, community: 30 },
      members: 3,
    });
    expect(GUILD_SEASON_FORMULA_VERSION).toBe(1);
  });

  it('is deterministic and independent of member and stage order', () => {
    const rng = createRng('guild-seasons');
    const rnd = () => rng.next();
    for (let i = 0; i < 200; i++) {
      const input: GuildSeasonInput = {
        stages: Array.from({ length: Math.floor(rnd() * 20) }, () => 1 + Math.floor(rnd() * 5)),
        members: Array.from({ length: Math.floor(rnd() * 30) }, () =>
          member(Math.floor(rnd() * 26), [
            {
              projectId: 'deepLanterns',
              stageId: 'lanternChains',
              resource: 'gold',
              amount: 1 + Math.floor(rnd() * 60_000),
            },
          ]),
        ),
      };
      const a = guildSeasonScore(input);
      expect(guildSeasonScore(JSON.parse(JSON.stringify(input)))).toEqual(a);
      const shuffled = {
        stages: [...input.stages].reverse(),
        members: [...input.members].reverse(),
      };
      expect(guildSeasonScore(shuffled)).toEqual(a);
      expect(a.value).toBe(a.parts.boss + a.parts.pve + a.parts.community);
      expect(a.parts.pve).toBeLessThanOrEqual(2_000);
      expect(a.parts.community).toBeLessThanOrEqual(2_000);
    }
  });

  it('counts only the best 20 members and caps each member’s town works', () => {
    const many = { stages: [], members: Array.from({ length: 30 }, () => member(25)) };
    expect(guildSeasonScore(many).parts.pve).toBe(2_000);
    const rich = member(0, [
      { projectId: 'deepLanterns', stageId: 'lanternPosts', resource: 'gold', amount: 90_000 },
      { projectId: 'deepLanterns', stageId: 'lanternChains', resource: 'gold', amount: 130_000 },
    ]);
    expect(memberCommunityPoints(rich)).toBe(100);
  });

  it('never trusts odd input', () => {
    expect(memberPvePoints({ pve: { value: 99, of: 25 }, gifts: [] })).toBe(100);
    expect(memberPvePoints({ pve: { value: -3, of: 25 }, gifts: [] })).toBe(0);
    expect(memberPvePoints({ pve: { value: 5, of: 0 }, gifts: [] })).toBe(0);
    expect(
      memberCommunityPoints({
        pve: null,
        gifts: [{ projectId: 'nope', stageId: 'x', resource: 'gold', amount: 1e9 }],
      }),
    ).toBe(0);
    // More than the need counts as the need.
    expect(
      memberCommunityPoints({
        pve: null,
        gifts: [
          { projectId: 'restoreWarehouse', stageId: 'clearRubble', resource: 'gold', amount: 1e9 },
        ],
      }),
    ).toBe(
      memberCommunityPoints({
        pve: null,
        gifts: [
          {
            projectId: 'restoreWarehouse',
            stageId: 'clearRubble',
            resource: 'gold',
            amount: 4_000,
          },
        ],
      }),
    );
    expect(guildSeasonScore({ stages: [7, 0, 2.5, -1], members: [] }).parts.boss).toBe(0);
    expect(() => guildSeasonScore(sample, 2)).toThrow(RangeError);
  });

  it('orders by the key, then reached first, then the guild id', () => {
    const e = (k: number[], at: number, id: string) => ({
      sortKey: k,
      achievedAt: at,
      guildId: id,
    });
    const list = [
      e([10, 5, 5, 0], 1, 'b'),
      e([10, 6, 4, 0], 9, 'c'),
      e([10, 5, 5, 0], 1, 'a'),
      e([11, 0, 0, 11], 99, 'd'),
    ];
    expect(list.sort(compareGuildEntries).map((x) => x.guildId)).toEqual(['d', 'c', 'a', 'b']);
  });
});

describe('the churn rules', () => {
  const end = new Date('2027-03-01T00:00:00.000Z');
  const days = (n: number) => new Date(end.getTime() - n * 86_400_000);

  it('counts a member from their seventh day', () => {
    expect(memberCounts(days(7), end)).toBe(true);
    expect(memberCounts(new Date(days(7).getTime() + 1), end)).toBe(false);
    expect(GUILD_SEASON_RULES.countAfterDays).toBe(7);
  });

  it('honours only members of fourteen days at the season’s end', () => {
    expect(memberHonourEligible(days(14), end)).toBe(true);
    expect(memberHonourEligible(new Date(days(14).getTime() + 1), end)).toBe(false);
    expect(memberHonourEligible(days(13), end)).toBe(false);
  });

  it('counts town-works gifts only from the day after joining, inside the season', () => {
    const window = { startsAt: days(56), endsAt: end };
    const joined = new Date('2027-02-10T15:00:00.000Z');
    expect(giftDayCounts('2027-02-10', joined, window)).toBe(false);
    expect(giftDayCounts('2027-02-11', joined, window)).toBe(true);
    expect(giftDayCounts('2027-02-28', joined, window)).toBe(true);
    expect(giftDayCounts('2027-03-01', joined, window)).toBe(false);
    const early = new Date('2026-01-01T00:00:00.000Z');
    expect(giftDayCounts(days(57).toISOString().slice(0, 10), early, window)).toBe(false);
    expect(giftDayCounts(days(56).toISOString().slice(0, 10), early, window)).toBe(true);
    expect(giftDayCounts('not a day', early, window)).toBe(false);
  });
});

describe('guild honours', () => {
  it('scale with the board', () => {
    const tiers = (size: number) =>
      Array.from({ length: size }, (_, i) => guildHonourTierFor(i + 1, size));
    expect(tiers(1)).toEqual(['champion']);
    expect(tiers(3)).toEqual(['champion', 'exalted', 'renowned']);
    expect(tiers(5)).toEqual(['champion', 'exalted', 'renowned', null, null]);
    expect(tiers(10).filter(Boolean)).toEqual(['champion', 'exalted', 'renowned']);
    expect(tiers(40).filter(Boolean)).toEqual([
      'champion',
      'exalted',
      'exalted',
      ...Array(7).fill('renowned'),
    ]);
    for (let size = 1; size < 300; size++) {
      let last = 0;
      for (const t of GUILD_HONOUR_TIERS) {
        const lp = guildTierLastPlace(t, size);
        expect(lp).toBeGreaterThanOrEqual(last);
        expect(lp).toBeLessThanOrEqual(size);
        last = lp;
      }
    }
  });

  it('awards each guild once, whatever the order', () => {
    const standings = Array.from({ length: 12 }, (_, i) => ({ guildId: `g${i}`, rank: i + 1 }));
    const a = guildSeasonAwards(standings);
    expect(guildSeasonAwards([...standings].reverse())).toEqual(a);
    expect(new Set(a.map((x) => x.guildId)).size).toBe(a.length);
    expect(a[0]).toEqual({ guildId: 'g0', rank: 1, tier: 'champion' });
  });

  it('grant cosmetics cumulatively by tier', () => {
    expect(guildSeasonCosmeticsEarned('renowned')).toEqual([
      'banner.guild-renowned',
      'crest.guild-renowned',
    ]);
    expect(guildSeasonCosmeticsEarned('exalted')).toHaveLength(4);
    expect(guildSeasonCosmeticsEarned('champion')).toHaveLength(6);
    expect(COSMETICS.filter((c) => c.source.kind === 'guildSeason')).toHaveLength(6);
  });
});

// The import scan (no rule reads guild-seasons/ or guild-halls/) is in the server's
// guild-seasons tests: game-core has no Node types.
