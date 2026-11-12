import { describe, expect, it } from 'vitest';
import {
  AREA_LOOT_TABLES,
  AREAS,
  BOSS_LOOT_TABLES,
  CLASS_IDS,
  COMMUNITY_PROJECTS,
  COSMETICS,
  DEFAULT_AWAKENING_SETTINGS,
  DUNGEONS,
  EVENT_CLOSE_GRACE_MS,
  EVENT_DEFINITIONS,
  GUILD_HALL_UPGRADES,
  awakenItem,
  findEventDefinition,
  guildSeasonCosmeticsEarned,
  nextCalendarEvent,
  settleFarming,
  type AreaId,
  type ClassId,
  type EquippedItem,
  type EventCalendarSettings,
  type EventWindow,
} from '../index.js';
import { legendaryKit, upgraded } from './kits.js';

/**
 * Ticket 8.7: the Phase 8 exit criterion in numbers (docs/ROADMAP.md Phase 8 exit; docs/BALANCE.md
 * "Phase 8 exit criterion"): the new endgame region keeps Phase 6 content relevant, the event
 * calendar runs on its own, and nothing Phase 8 added grants power. game-core only, fixed seeds,
 * so a band fails only when a rule or content changes. The server half (the import scan and a
 * hero's numbers before and after every cosmetic, hall upgrade and keepsake) is
 * `apps/server/src/phase8-no-pay-to-win.test.ts`.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEEDS = ['p8-a', 'p8-b', 'p8-c', 'p8-d'];

interface Hour {
  deaths: number;
  kpm: number;
  xp: number;
  gold: number;
}
const memo = new Map<string, Hour>();
/** One hour of farming, the mean over fixed seeds. */
function hour(c: ClassId, level: number, areaId: AreaId, gear: string, items: EquippedItem[]) {
  const key = `${c}:${level}:${areaId}:${gear}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const sum = { deaths: 0, kills: 0, xp: 0, gold: 0 };
  for (const seed of SEEDS) {
    const r = settleFarming({
      character: { classId: c, level, xp: 0 },
      equipment: items,
      areaId,
      seed: `${seed}:${key}`,
      firstCycle: 0,
      durationMs: HOUR,
      inventoryCount: 0,
    });
    sum.deaths += r.deaths;
    sum.kills += r.kills;
    sum.xp += r.xpGained;
    sum.gold += r.goldLooted;
  }
  const n = SEEDS.length;
  const out = {
    deaths: sum.deaths / n,
    kpm: sum.kills / (n * 60),
    xp: sum.xp / n,
    gold: sum.gold / n,
  };
  memo.set(key, out);
  return out;
}
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

describe('Phase 8 exit 1: Phase 6 content stays relevant next to Region III (ticket 8.7)', () => {
  it.each(CLASS_IDS)(
    '%s: Phase 6 gear opens the Hollow Reach, and the Marches’ gear the Deep, without a wall',
    (c) => {
      // Phase 6's best drops (the Cinder Depths' and Heroic's Legendaries, +10) at 40 in the Pale
      // Marches, against the Depths at 40; the Marches' best at 46 in the Deep against the Marches.
      const depthsKit = upgraded(legendaryKit(c, 39), 10);
      const heroicKit = upgraded(legendaryKit(c, 37), 10);
      const marchesKit = upgraded(legendaryKit(c, 47), 10);
      const depths = hour(c, 40, 'cinderDepths', 'depths', depthsKit);
      const marches = hour(c, 40, 'paleMarches', 'depths', depthsKit);
      const heroicMarches = hour(c, 40, 'paleMarches', 'heroic', heroicKit);
      const marchesTop = hour(c, 46, 'paleMarches', 'marches', marchesKit);
      const deep = hour(c, 46, 'hollowDeep', 'marches', marchesKit);
      const record = {
        class: c,
        marchesVsDepths: {
          kpm: round(marches.kpm / depths.kpm),
          xp: round(marches.xp / depths.xp),
          gold: round(marches.gold / depths.gold),
        },
        heroicInMarches: { kpm: round(heroicMarches.kpm, 1), deaths: heroicMarches.deaths },
        deepVsMarches: {
          kpm: round(deep.kpm / marchesTop.kpm),
          xp: round(deep.xp / marchesTop.xp),
          gold: round(deep.gold / marchesTop.gold),
        },
      };
      // No deaths: the step up is slower kills, never a wall.
      for (const h of [marches, heroicMarches, deep])
        expect(h.deaths, JSON.stringify(record)).toBe(0);
      expect(marches.kpm / depths.kpm).toBeGreaterThan(0.7);
      // Heroic's Legendaries (item level 37) still clear the Marches' entry, a little slower.
      expect(heroicMarches.kpm).toBeGreaterThan(6);
      expect(deep.kpm / marchesTop.kpm).toBeGreaterThan(0.7);
      // Worth the step: each new place pays more an hour than the one before it.
      expect(marches.xp / depths.xp).toBeGreaterThan(1);
      expect(marches.gold / depths.gold).toBeGreaterThan(1);
      expect(deep.xp / marchesTop.xp).toBeGreaterThan(1);
      expect(deep.gold / marchesTop.gold).toBeGreaterThan(0.98);
    },
    60_000,
  );

  it('Phase 6 places keep drops only they give, which Region III play still spends', () => {
    const dropsOf = (materialId: string) =>
      DUNGEONS.filter((d) => (d.bossDrops as readonly string[]).includes(materialId)).map(
        (d) => d.id,
      );
    // The Tyrant's Ember (the Tyrant's Forge, 6.2) and the Gravewarden's Seal (the crypt, Heroic
    // its top tier) come only from their Phase 6 bosses; no Region III place drops either.
    expect(dropsOf('tyrantsEmber')).toEqual(['tyrantsForge']);
    expect(dropsOf('gravewardenSeal')).toEqual(['namelessCrypt']);
    for (const id of ['paleMarches', 'hollowDeep'] as const) {
      const area = AREAS.find((a) => a.id === id)!;
      expect(area.materials).not.toContain('tyrantsEmber');
      expect(area.materials).not.toContain('gravewardenSeal');
    }
    // Both pay for Item Awakening, which works on Region III's tier-5 Legendaries too…
    expect(DEFAULT_AWAKENING_SETTINGS.cost).toMatchObject({ tyrantsEmber: 3, gravewardenSeal: 2 });
    const t5 = upgraded(legendaryKit('warrior', 53), 10).find((i) => i.effectId);
    expect(t5, 'a tier-5 Legendary with an effect').toBeDefined();
    expect(awakenItem(t5!).ok).toBe(true);
    // … and the town needed ten Embers to light the lanterns of the deep (8.2's gate).
    const lanterns = COMMUNITY_PROJECTS.find((p) => p.id === 'deepLanterns')!;
    const embers = lanterns.stages
      .flatMap((s) => s.needs)
      .filter((n) => n.resource === 'tyrantsEmber')
      .reduce((s, n) => s + n.amount, 0);
    expect(embers).toBe(10);
    // Heroic stays the best place to look for a Prismatic (6.4): its odds beat Region III's.
    const heroic =
      [...AREA_LOOT_TABLES, ...BOSS_LOOT_TABLES].find((t) => t.id === 'namelessCryptIV') ?? null;
    const prismaticOf = (t: { prismaticChance?: number } | undefined | null) =>
      t?.prismaticChance ?? 0;
    const reach = ['paleMarches', 'hollowDeep'].map((id) =>
      prismaticOf(AREA_LOOT_TABLES.find((t) => t.id === id)),
    );
    expect(heroic, 'the Heroic table').not.toBeNull();
    for (const r of reach) expect(prismaticOf(heroic)).toBeGreaterThan(r);
  });
});

describe('Phase 8 exit 2: the event calendar runs on its own (ticket 8.7)', () => {
  /**
   * A year of the calendar with nobody touching it: the scheduler creates each event at its first
   * run after the previous one closes (the end plus the close grace), from the rotation the exit
   * run uses (the shipped default's order, with a two-day gap) and the shipped default itself.
   */
  function year(settings: EventCalendarSettings, from: Date) {
    const events: (EventWindow & { definitionId: string })[] = [];
    let s = { ...settings, paused: false };
    let now = from;
    while (now.getTime() < from.getTime() + 365 * DAY) {
      const plan = nextCalendarEvent(s, events, now);
      expect(plan).not.toBeNull();
      events.push({
        number: events.length + 1,
        definitionId: plan!.definitionId,
        startsAt: plan!.startsAt,
        endsAt: plan!.endsAt,
        closedAt: new Date(plan!.endsAt.getTime() + EVENT_CLOSE_GRACE_MS),
        cancelledAt: null,
      } as EventWindow & { definitionId: string });
      s = { ...s, nextIndex: (plan!.index + 1) % s.rotation.length };
      now = new Date(plan!.endsAt.getTime() + EVENT_CLOSE_GRACE_MS);
    }
    return events;
  }

  it.each([
    ['the exit run’s (gap 2)', 2],
    ['the shipped default (gap 7)', 7],
    ['no gap', 0],
  ] as const)('%s: Mondays, full lengths, no overlap, every entry in turn', (_label, gapDays) => {
    const settings: EventCalendarSettings = {
      paused: false,
      rotation: [
        { definitionId: 'lanternProcession', days: 28 },
        { definitionId: 'harvestOfBones', days: 7 },
      ],
      gapDays,
      nextIndex: 0,
    };
    // A Wednesday afternoon, derived from nothing but the epoch (a pure rule, no wall clock).
    const from = new Date(Date.UTC(2030, 0, 2, 15, 30));
    const list = year(settings, from);
    for (const [n, e] of list.entries()) {
      expect(e.startsAt.getUTCDay(), `event ${n + 1} on a Monday`).toBe(1);
      expect(e.startsAt.getUTCHours() + e.startsAt.getUTCMinutes()).toBe(0);
      const entry = settings.rotation[n % 2]!;
      expect(e.definitionId).toBe(entry.definitionId);
      const days = (e.endsAt.getTime() - e.startsAt.getTime()) / DAY;
      expect(days).toBe(entry.days);
      // A weekly event gets all its weeks (8.3b).
      const weeks = findEventDefinition(entry.definitionId)!.quests.reduce(
        (w, q) => Math.max(w, q.week ?? 1),
        1,
      );
      expect(days).toBeGreaterThanOrEqual(weeks * 7);
      if (n > 0) {
        const gap = (e.startsAt.getTime() - list[n - 1]!.endsAt.getTime()) / DAY;
        // At least the gap, at most the gap plus the wait for the next Monday.
        expect(gap).toBeGreaterThanOrEqual(gapDays);
        expect(gap).toBeLessThanOrEqual(gapDays + 7);
      }
    }
    const covered = list.reduce((s, e) => s + (e.endsAt.getTime() - e.startsAt.getTime()), 0);
    // Pinned (docs/BALANCE.md "Phase 8 exit criterion"): both events end on a Monday, so any gap of
    // 0–7 days is a one-week pause: 15 events a year, 8 of them Processions, 273 days with one.
    expect({
      events: list.length,
      processions: list.filter((e) => e.definitionId === 'lanternProcession').length,
      days: Math.round(covered / DAY),
    }).toEqual({ events: 15, processions: 8, days: 273 });
  });
});

describe('Phase 8 exit 3: nothing Phase 8 added grants power (ticket 8.7)', () => {
  it('events reward cosmetics and materials only', () => {
    const ids = new Set(COSMETICS.map((x) => x.id));
    for (const e of EVENT_DEFINITIONS) {
      for (const t of e.track) {
        expect(ids.has(t.cosmeticId), `${e.id} tier ${t.tier}`).toBe(true);
        expect(Object.keys(t).sort()).toEqual(['cosmeticId', 'tallies', 'tier']);
      }
      // The world modifiers hand out a material (a bounty), never a stat, an odds or XP change.
      expect(['killBounty', 'gatherBounty']).toContain(e.modifier.kind);
    }
  });

  it('cosmetics, guild halls and guild honours carry no numbers a rule could read', () => {
    // Display data only: no stat, odds, multiplier or level key anywhere.
    const keysOf = (xs: readonly object[]) => [...new Set(xs.flatMap((x) => Object.keys(x)))];
    expect(keysOf(COSMETICS).sort()).toEqual(['description', 'id', 'kind', 'name', 'source']);
    expect(keysOf(GUILD_HALL_UPGRADES).sort()).toEqual([
      'description',
      'id',
      'kind',
      'name',
      'price',
    ]);
    // A hall upgrade's only number is its price (paid into nothing but the look).
    for (const u of GUILD_HALL_UPGRADES) {
      expect(Object.keys(u.price).sort()).toEqual(['gold', 'materials']);
    }
    // Guild honours are catalogue cosmetics.
    const ids = new Set(COSMETICS.map((x) => x.id));
    for (const tier of ['champion', 'exalted', 'renowned'] as const) {
      const earned = guildSeasonCosmeticsEarned(tier);
      expect(earned.length).toBeGreaterThan(0);
      for (const id of earned) expect(ids.has(id), id).toBe(true);
    }
  });
});
