import { describe, expect, it } from 'vitest';
import { GUILD_REFUSALS, GUILD_STANDINGS } from '../social/guilds.js';
import {
  GUILD_BOSSES,
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  countedDamage,
  getGuildBoss,
  guildBossOfWeek,
  guildBossStageOf,
  sumStageRewards,
} from './definitions.js';
import { simulateGuildBossAttempt } from './fight.js';
import { GUILD_BOSS_ACTIONS, GUILD_BOSS_REFUSALS, guildBossDecision } from './permissions.js';
import { WEEK_MS, guildBossWeek, guildBossWeekFromKey } from './week.js';

const boss = getGuildBoss('risenGravewarden');

describe('guild boss week (UTC, Monday 00:00 inclusive → next Monday exclusive)', () => {
  it('starts on Monday 00:00 UTC', () => {
    // 2026-11-07 is a Saturday.
    const w = guildBossWeek(Date.parse('2026-11-07T12:00:00Z'));
    expect(w.key).toBe('2026-11-02');
    expect(new Date(w.startMs).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(new Date(w.endMs).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(w.endMs - w.startMs).toBe(WEEK_MS);
  });

  it('puts the last millisecond of Sunday in the old week and Monday 00:00 in the new one', () => {
    const end = Date.parse('2026-11-09T00:00:00Z');
    expect(guildBossWeek(end - 1).key).toBe('2026-11-02');
    expect(guildBossWeek(end).key).toBe('2026-11-09');
    expect(guildBossWeek(Date.parse('2026-11-02T00:00:00Z')).key).toBe('2026-11-02');
  });

  it('ignores the local time zone and handles years and the epoch', () => {
    expect(guildBossWeek(Date.parse('2027-01-01T03:00:00+05:00')).key).toBe('2026-12-28');
    expect(guildBossWeek(0).key).toBe('1969-12-29');
    expect(guildBossWeek(-1).key).toBe('1969-12-29');
  });

  it('round-trips keys and refuses anything but a Monday', () => {
    expect(guildBossWeekFromKey('2026-11-02').startMs).toBe(Date.parse('2026-11-02T00:00:00Z'));
    for (const bad of ['2026-11-03', '2026-13-01', 'monday', '2026-11-2'])
      expect(() => guildBossWeekFromKey(bad)).toThrow(RangeError);
  });

  it('picks the boss from the week only', () => {
    const w = guildBossWeek(Date.parse('2026-11-07T00:00:00Z'));
    expect(guildBossOfWeek(w)).toBe(guildBossOfWeek(guildBossWeek(w.endMs - 1)));
    expect(GUILD_BOSSES).toContain(guildBossOfWeek(w));
  });
});

describe('guild boss data', () => {
  it('has ascending stages with personal rewards', () => {
    for (const b of GUILD_BOSSES) {
      b.stages.forEach((s, i) => {
        expect(s.stage).toBe(i + 1);
        if (i > 0) expect(s.threshold).toBeGreaterThan(b.stages[i - 1]!.threshold);
        expect(s.reward.gold).toBeGreaterThan(0);
      });
    }
  });

  it('reaches stages by the weekly total', () => {
    expect(guildBossStageOf(boss, 0)).toBe(0);
    expect(guildBossStageOf(boss, boss.stages[0]!.threshold - 1)).toBe(0);
    expect(guildBossStageOf(boss, boss.stages[0]!.threshold)).toBe(1);
    expect(guildBossStageOf(boss, Number.MAX_SAFE_INTEGER)).toBe(boss.stages.length);
  });

  it('caps what one attempt counts', () => {
    expect(countedDamage(boss, 1234.9)).toBe(1234);
    expect(countedDamage(boss, boss.attemptDamageCap * 3)).toBe(boss.attemptDamageCap);
    expect(countedDamage(boss, -5)).toBe(0);
  });

  it('keeps the weekly personal reward small (no outsized power)', () => {
    const all = sumStageRewards(
      boss,
      boss.stages.map((s) => s.stage),
    );
    // About four hours of Sunken Abbey farming gold (~700/h, docs/ECONOMY.md) at most per week.
    expect(all.gold).toBeLessThanOrEqual(3_500);
    expect(all.materials.gravewardenSeal ?? 0).toBeLessThanOrEqual(2);
    expect(() => sumStageRewards(boss, [99])).toThrow(RangeError);
  });
});

describe('a guild boss attempt', () => {
  const input = {
    bossId: boss.id,
    character: { classId: 'warrior' as const, level: 14 },
    seed: 'secret:2026-11-02:1',
  };

  it('is deterministic: the same seed and snapshot give the same fight', () => {
    expect(simulateGuildBossAttempt(input)).toEqual(simulateGuildBossAttempt(input));
  });

  it('differs between attempts (another seed)', () => {
    const a = simulateGuildBossAttempt(input);
    const b = simulateGuildBossAttempt({ ...input, seed: 'secret:2026-11-02:2' });
    expect(a.events).not.toEqual(b.events);
  });

  it('never kills the boss, sums the damage of its log and ends by the window', () => {
    for (const level of [10, 20, 28]) {
      const r = simulateGuildBossAttempt({ ...input, character: { classId: 'mage', level } });
      const logged = r.events
        .filter((e) => e.type === 'attack' || e.type === 'thorns')
        .reduce((s, e) => s + ('damage' in e ? e.damage : 0), 0);
      expect(r.damage).toBe(logged);
      expect(r.counted).toBe(Math.min(r.damage, boss.attemptDamageCap));
      expect(r.durationMs).toBeLessThanOrEqual(boss.fightMs);
      expect(r.events.some((e) => e.type === 'kill')).toBe(false);
      if (r.end === 'fell') expect(r.health).toBe(0);
      else expect(r.durationMs).toBe(boss.fightMs);
      expect(r.bossLevel).toBe(level + boss.levelOffset);
      expect(r.enrageAtMs).toBeGreaterThanOrEqual(boss.enrage.atMs.min);
      expect(r.enrageAtMs).toBeLessThanOrEqual(boss.enrage.atMs.max);
    }
  });

  it('refuses bad input', () => {
    expect(() => simulateGuildBossAttempt({ ...input, bossId: 'nope' })).toThrow(RangeError);
    expect(() => simulateGuildBossAttempt({ ...input, seed: '' })).toThrow(RangeError);
    expect(() =>
      simulateGuildBossAttempt({ ...input, character: { classId: 'warrior', level: 0 } }),
    ).toThrow(RangeError);
  });
});

describe('guildBossDecision (permission matrix)', () => {
  const expected: Record<string, Record<string, string>> = {
    view: { leader: 'ok', officer: 'ok', member: 'ok', none: 'not_in_guild' },
    attempt: { leader: 'ok', officer: 'ok', member: 'ok', none: 'not_in_guild' },
    claim: { leader: 'ok', officer: 'ok', member: 'ok', none: 'ok' },
  };

  it('every standing × action', () => {
    for (const action of GUILD_BOSS_ACTIONS) {
      for (const standing of GUILD_STANDINGS) {
        const d = guildBossDecision(standing, action, boss);
        expect(d === 'allowed' ? 'ok' : d.code, `${standing} ${action}`).toBe(
          expected[action]![standing],
        );
      }
    }
    expect(guildBossDecision('none', 'attempt')).toBe(GUILD_REFUSALS.notInGuild);
  });

  it('state refusals after the standing', () => {
    const used = { attemptsUsed: GUILD_BOSS_ATTEMPTS_PER_WEEK };
    expect(guildBossDecision('member', 'attempt', boss, used)).toBe(
      GUILD_BOSS_REFUSALS.noAttemptsLeft,
    );
    expect(guildBossDecision('none', 'attempt', boss, used)).toBe(GUILD_REFUSALS.notInGuild);
    expect(
      guildBossDecision('member', 'attempt', boss, {
        attemptsUsed: 0,
        heroLevel: boss.minLevel - 1,
      }),
    ).toBe(GUILD_BOSS_REFUSALS.heroTooLow);
    expect(
      guildBossDecision('member', 'attempt', boss, { attemptsUsed: 2, heroLevel: boss.minLevel }),
    ).toBe('allowed');
    expect(guildBossDecision('none', 'claim', boss, { unclaimed: 0 })).toBe(
      GUILD_BOSS_REFUSALS.nothingToClaim,
    );
  });
});
