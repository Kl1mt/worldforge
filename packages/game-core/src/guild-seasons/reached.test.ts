import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import {
  compareGuildEntries,
  guildSeasonInputAt,
  guildSeasonReachedAt,
  guildSeasonScore,
  type GuildSeasonTimedMember,
  type GuildSeasonTimeline,
} from './index.js';

/** Ticket 8.4b: "reached at" from the facts' own times (docs/LEADERBOARDS.md "Guild seasons"). */
const H = 3_600_000;
const START = 1_000 * H;
const window = { startsAt: START, at: START + 1_000 * H };

const gift = (amount: number, at: number) => ({
  projectId: 'restoreWarehouse',
  stageId: 'clearRubble',
  resource: 'gold' as const,
  amount,
  at,
});
const member = (over: Partial<GuildSeasonTimedMember> = {}): GuildSeasonTimedMember => ({
  countsFrom: START - 100 * H,
  pve: null,
  gifts: [],
  ...over,
});

describe('guild season "reached at"', () => {
  it('is the time of the latest fact that raised the total', () => {
    const t: GuildSeasonTimeline = {
      stages: [
        { stage: 1, at: START + 5 * H },
        { stage: 2, at: START + 9 * H },
      ],
      members: [member({ pve: { value: 20, of: 25, at: START + 7 * H } })],
    };
    expect(guildSeasonReachedAt(t, window)).toBe(START + 9 * H);
    // The input at the end is the whole input; at 8 h the second stage is not in it yet.
    expect(guildSeasonScore(guildSeasonInputAt(t)).value).toBe(20 + 40 + 80);
    expect(guildSeasonScore(guildSeasonInputAt(t, START + 8 * H)).value).toBe(20 + 80);
  });

  it('does not move for a fact that raised nothing (a gift past the member cap)', () => {
    const capped: GuildSeasonTimeline = {
      stages: [],
      members: [member({ gifts: [gift(40_000, START + 2 * H)] })],
    };
    const before = guildSeasonReachedAt(capped, window);
    expect(before).toBe(START + 2 * H);
    const more: GuildSeasonTimeline = {
      stages: [],
      members: [member({ gifts: [gift(40_000, START + 2 * H), gift(9_000, START + 30 * H)] })],
    };
    expect(guildSeasonScore(guildSeasonInputAt(more)).value).toBe(
      guildSeasonScore(guildSeasonInputAt(capped)).value,
    );
    expect(guildSeasonReachedAt(more, window)).toBe(before);
  });

  it('counts a member’s facts only from when they count, and stays inside the window', () => {
    const late: GuildSeasonTimeline = {
      stages: [],
      members: [member({ countsFrom: START + 40 * H, pve: { value: 25, of: 25, at: START - H } })],
    };
    expect(guildSeasonReachedAt(late, window)).toBe(START + 40 * H);
    // Facts from before the season (a PvE share reached last season) count from its start.
    const old: GuildSeasonTimeline = {
      stages: [],
      members: [member({ pve: { value: 25, of: 25, at: START - 50 * H } })],
    };
    expect(guildSeasonReachedAt(old, window)).toBe(START);
    // A fact later than `at` (the archive reads a row moved after the end) is clamped to it.
    const after: GuildSeasonTimeline = {
      stages: [],
      members: [member({ pve: { value: 25, of: 25, at: window.at + H } })],
    };
    expect(guildSeasonReachedAt(after, window)).toBe(window.at);
    // Nothing scored: the window's start.
    expect(guildSeasonReachedAt({ stages: [], members: [member()] }, window)).toBe(START);
  });

  it('orders two guilds tied on every part by who reached it first', () => {
    const tied = (lastStageAt: number): GuildSeasonTimeline => ({
      stages: [
        { stage: 1, at: START + H },
        { stage: 2, at: lastStageAt },
      ],
      members: [member({ pve: { value: 25, of: 25, at: START + 2 * H } })],
    });
    const early = tied(START + 3 * H);
    const late = tied(START + 4 * H);
    const key = guildSeasonScore(guildSeasonInputAt(early)).sortKey;
    expect(guildSeasonScore(guildSeasonInputAt(late)).sortKey).toEqual(key);
    const rows = [
      { sortKey: key, achievedAt: guildSeasonReachedAt(late, window), guildId: 'a' },
      { sortKey: key, achievedAt: guildSeasonReachedAt(early, window), guildId: 'b' },
    ];
    expect(rows.sort(compareGuildEntries).map((r) => r.guildId)).toEqual(['b', 'a']);
  });

  it('over random timelines: the score is complete at "reached at" and short just before', () => {
    const rng = createRng('guild-reached-at');
    const pick = (n: number) => Math.floor(rng.next() * n);
    for (let run = 0; run < 400; run++) {
      const t: GuildSeasonTimeline = {
        stages: Array.from({ length: pick(6) }, () => ({
          stage: 1 + pick(5),
          at: START + pick(500) * H,
        })),
        members: Array.from({ length: pick(25) }, () =>
          member({
            countsFrom: START + (pick(200) - 100) * H,
            pve: rng.next() < 0.7 ? { value: pick(26), of: 25, at: START + pick(500) * H } : null,
            gifts: Array.from({ length: pick(4) }, () => gift(pick(3_000), START + pick(500) * H)),
          }),
        ),
      };
      const final = guildSeasonScore(guildSeasonInputAt(t)).value;
      const at = guildSeasonReachedAt(t, window);
      expect(at).toBeGreaterThanOrEqual(window.startsAt);
      expect(at).toBeLessThanOrEqual(window.at);
      expect(guildSeasonScore(guildSeasonInputAt(t, at)).value).toBe(final);
      if (at > START) {
        expect(guildSeasonScore(guildSeasonInputAt(t, at - 1)).value).toBeLessThan(final);
      }
      // Deterministic: the same facts in another member order give the same moment.
      const shuffled = { ...t, members: [...t.members].reverse() };
      expect(guildSeasonReachedAt(shuffled, window)).toBe(at);
    }
  });
});
