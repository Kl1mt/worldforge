// Ticket B.5: the endgame balance pass (docs/BALANCE.md "B.5"). Dev script; guards in
// packages/game-core/src/balance/endgame-balance.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/endgame.ts bosses
//   bosses: the Forge Tyrant and the Heroic Gravewarden per class: Legendary kits (with effects,
//           SAMPLES kit samples × RUNS seeds) at +0/+5/+10, and the best farming build (+5, +10
//           Void) with its mean and fastest kill. Try boss data without editing it:
//           TYRANT_SCALE=res,arm HEROIC_SCALE=res,arm (multipliers on resistance and armour),
//           TYRANT_SHELL=until,multiplier (the slag shell).
//   procession: ticket 8.3, the Lantern Procession's pacing (docs/EVENTS.md): per hero and class,
//           kills and gathered materials an hour, the modifier's ore, and the hours of farming
//           each week's open-road and deeper-road farming tasks take.
//   sinks:  ticket 6.11, the Seal and Abbey silver flow of a season, before and after the
//           exchange and the engraver (docs/BALANCE.md "6.11"): Embers and Seals a day from the
//           Tyrant and the crypt (as `awakening.ts time`), Abbey silver gathered from 17 to 23.
import * as G from '../../packages/game-core/src/index.ts';
import { kit, legendarySample, upgraded } from '../../packages/game-core/src/balance/kits.ts';
import {
  PASS_FARM_JOB,
  buildItems,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
} from '../../packages/game-core/src/balance/builds.ts';

const mode = process.argv[2] ?? 'bosses';
const RUNS = Number(process.env.RUNS ?? 12);
const SAMPLES = Number(process.env.SAMPLES ?? 8);
const pct = (x: number) => `${Math.round(x * 100)}`.padStart(3);

function override(dungeonId: G.DungeonId, tier: number, env: string | undefined) {
  if (!env) return;
  const [res, arm] = env.split(',').map(Number);
  const t = G.DUNGEONS.find((d) => d.id === dungeonId)!.tiers.find((x) => x.tier === tier)!;
  const base = t.bossScale ?? { health: 1, damage: 1 };
  (t as { bossScale?: G.EnemyScale }).bossScale = { ...base, resistance: res!, armor: arm! };
  console.log(`${dungeonId} ${tier}: bossScale ${JSON.stringify(t.bossScale)}`);
}
override('tyrantsForge', 1, process.env.TYRANT_SCALE);
if (process.env.TYRANT_BURN) {
  const [everyMs, share] = process.env.TYRANT_BURN.split(',').map(Number);
  const t = G.DUNGEONS.find((d) => d.id === 'tyrantsForge')!.tiers[0]!;
  (t as { bossMechanics?: G.BossMechanics }).bossMechanics = {
    ...t.bossMechanics,
    burn: { everyMs: everyMs!, damageShare: share! },
  };
}
if (process.env.TYRANT_SHELL) {
  const [until, mult] = process.env.TYRANT_SHELL.split(',').map(Number);
  const t = G.DUNGEONS.find((d) => d.id === 'tyrantsForge')!.tiers[0]!;
  (t as { bossMechanics?: G.BossMechanics }).bossMechanics = {
    ...t.bossMechanics,
    shell: { untilHealthShare: until!, damageTakenMultiplier: mult! },
  };
  console.log(`tyrant mechanics ${JSON.stringify(t.bossMechanics)}`);
}
override('namelessCrypt', 4, process.env.HEROIC_SCALE);

function run(
  d: G.DungeonId,
  tier: G.DungeonTier,
  c: G.ClassId,
  level: number,
  eq: G.EquippedItem[],
  n = RUNS,
  mod: G.BossModifierId | null = null,
) {
  let wins = 0;
  let t = 0;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const r = G.simulateDungeonRun({
      dungeonId: d,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: eq,
      seed: `b5-boss:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier: mod,
    });
    if (!r.bossDefeated) continue;
    wins++;
    const e = r.encounters.at(-1)!;
    t += e.endMs - e.startMs;
    min = Math.min(min, e.endMs - e.startMs);
  }
  return { rate: wins / n, mean: wins ? t / wins / 1000 : 0, min: min / 1000 };
}

const bestCache = new Map<G.ClassId, G.EquippedItem[][]>();
/** The best farming build at item level 33 (the Verge's drops), +5 and +10 Void, as 6.2. */
function best(c: G.ClassId) {
  let b = bestCache.get(c);
  if (!b) {
    const top = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    )[0]!.build;
    b = [
      buildItems({ ...top, upgradeLevel: 5 }, 33),
      buildItems({ ...top, upgradeLevel: 10, void: true }, 33),
    ];
    bestCache.set(c, b);
  }
  return b;
}

if (mode === 'bosses') {
  const fights: [string, G.DungeonId, G.DungeonTier, number[], number][] = [
    ['Forge Tyrant', 'tyrantsForge', 1, [36, 38], 35],
    ['Heroic', 'namelessCrypt', 4, [32, 34, 36], 30],
  ];
  for (const [name, d, tier, levels, enrage] of fights) {
    for (const level of levels) {
      console.log(`\n${name} at ${level} (0.4 × earliest enrage = ${(0.4 * enrage).toFixed(0)} s)`);
      for (const up of [0, 5, 10]) {
        const per = G.CLASS_IDS.map((c) => {
          let s = 0;
          for (let k = 0; k < SAMPLES; k++)
            s += run(d, tier, c, level, upgraded(legendarySample(c, 33, k), up)).rate;
          return s / SAMPLES;
        });
        const mean = per.reduce((a, b) => a + b) / per.length;
        console.log(
          `  Legendaries +${String(up).padEnd(2)} ${per.map(pct).join(' /')}  (mean ${pct(mean)}, spread ${pct(Math.max(...per) - Math.min(...per))})`,
        );
      }
      if (process.env.BEST !== '0') {
        for (const [i, label] of ['best +5', 'best +10 Void'].entries()) {
          const cells = G.CLASS_IDS.map((c) => {
            const r = run(d, tier, c, level, best(c)[i]!, RUNS * 2);
            return `${pct(r.rate)}% ${r.mean.toFixed(0)}s min ${Number.isFinite(r.min) ? r.min.toFixed(0) : '-'}`;
          });
          console.log(`  ${label.padEnd(15)} ${cells.join(' / ')}`);
        }
      }
    }
  }
}

/**
 * `pace`: XP and gold pacing from level 28 to 48 (the soft cap ~47–48). Per level, the hero farms
 * the best open area for XP (the Ashen Pass, the Ashfall Verge from 28, the Cinder Depths from 34)
 * in a realistic kit: Legendaries with effects at +5, item level = level − 2 within each area's
 * drops (Pass 25, Verge 29–35, Depths 35–39). Hours per level, XP and gold per hour (kill gold),
 * then the days to each level for the B.4 population's cadence: dedicated 15 credited hours a
 * day, regular 7.5, casual 3.75.
 */
if (mode === 'pace') {
  const SEEDS = Number(process.env.SEEDS ?? 2);
  const areaFor = (level: number): G.AreaId[] =>
    level >= 34
      ? ['ashfallVerge', 'cinderDepths']
      : level >= 28
        ? ['ashenPass', 'ashfallVerge']
        : ['ashenPass'];
  const kitLevel = (level: number) => Math.max(25, Math.min(39, level - 2));
  const levels = Array.from({ length: 21 }, (_, i) => 28 + i);
  const totals: Record<string, number[]> = {};
  for (const c of G.CLASS_IDS) {
    const row: string[] = [];
    let cum = 0;
    totals[c] = [];
    for (const level of levels) {
      const items = upgraded(legendarySample(c, kitLevel(level), 0), 5);
      let bestXph = 0;
      let gph = 0;
      let deaths = 0;
      let area = '';
      for (const areaId of areaFor(level)) {
        let xp = 0;
        let gold = 0;
        let d = 0;
        for (let s = 0; s < SEEDS; s++) {
          const r = G.settleFarming({
            character: { classId: c, level, xp: 0 },
            equipment: items,
            areaId,
            seed: `b5-pace:${c}:${level}:${s}`,
            firstCycle: 0,
            durationMs: 3_600_000,
            inventoryCount: 0,
          });
          xp += r.xpGained;
          gold += r.goldLooted + r.goldSalvaged;
          d += r.deaths;
        }
        if (xp / SEEDS > bestXph) {
          bestXph = xp / SEEDS;
          gph = gold / SEEDS;
          deaths = d / SEEDS;
          area = areaId;
        }
      }
      const hours = G.xpToNextLevel(level) / bestXph;
      cum += hours;
      totals[c]!.push(cum);
      row.push(
        `${level}:${hours.toFixed(1)}h ${Math.round(bestXph / 1000)}k ${Math.round(gph)}g ${deaths.toFixed(1)}d ${area.slice(0, 5)}`,
      );
    }
    console.log(`${c}\n  ${row.join('\n  ')}`);
  }
  for (const target of [34, 36, 40, 44, 48]) {
    const i = target - 28;
    const hours = G.CLASS_IDS.map((c) => totals[c]![i - 1]!);
    const lo = Math.min(...hours);
    const hi = Math.max(...hours);
    console.log(
      `28 → ${target}: ${lo.toFixed(0)}–${hi.toFixed(0)} h of farming · dedicated ${(lo / 15).toFixed(1)}–${(hi / 15).toFixed(1)} d · regular ${(lo / 7.5).toFixed(1)}–${(hi / 7.5).toFixed(1)} d · casual ${(lo / 3.75).toFixed(0)}–${(hi / 3.75).toFixed(0)} d`,
    );
  }
}

/**
 * `loot`: Heroic loot pace as build completion. The target is each class's best farming build
 * (the B.2 search, 6.2's measure) at the endgame's item levels: four set pieces of its set and a
 * Legendary with each chosen effect in its slot; a drop counts at item level 31 or more (the
 * Verge's, the Depths' and the Heroic crypt's bands). Rates per needed piece from game-core:
 * HOURS of Cinder Depths farming at 38 (a realistic kit: Legendaries +5, item level 36), RUNS × 10
 * Heroic runs at 36 (chambers; the hoard once a day: the crypt's 20 h cooldown) and the Tyrant's
 * hoard once a day (his own cooldown). A dedicated day: 15 hours of farming, five crypt runs, one
 * crypt hoard and one Tyrant hoard (6.5's cadence). Days to complete the build are sampled from the
 * rates (TRIALS), with and without the Heroic crypt.
 */
if (mode === 'loot') {
  const HOURS = Number(process.env.HOURS ?? 60);
  const TRIALS = Number(process.env.TRIALS ?? 4000);
  const MIN_IL = 31;
  type Need = { key: string; match: (i: G.GeneratedItem) => boolean };
  const slotOf = (baseId: string) => G.getItemBase(baseId as G.ItemBaseId)!.slot;
  for (const c of G.CLASS_IDS) {
    const top = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    )[0]!.build;
    const needs: Need[] = [];
    const ringEffects: string[] = [];
    for (const i of buildItems({ ...top, upgradeLevel: 0 }, 35)) {
      if (i.setId)
        needs.push({
          key: `set:${i.baseId}`,
          match: (d) => d.setId === i.setId && d.baseId === i.baseId && d.itemLevel >= MIN_IL,
        });
      else if (i.effectId) {
        const slot = slotOf(i.baseId);
        if (slot === 'ring') ringEffects.push(i.effectId);
        needs.push({
          key: `${slot}:${i.effectId}`,
          match: (d) =>
            d.rarityId === 'legendary' &&
            d.effectId === i.effectId &&
            slotOf(d.baseId) === slot &&
            d.itemLevel >= MIN_IL &&
            G.canClassUseItem(G.getItemBase(d.baseId)!, c),
        });
      }
    }
    const count = (drops: G.GeneratedItem[], n: number) =>
      needs.map((nd) => drops.filter(nd.match).length / n);
    // Depths farming, per hour.
    const farmDrops: G.GeneratedItem[] = [];
    const kitItems = upgraded(legendarySample(c, 36, 0), 5);
    let legs = 0;
    for (let h = 0; h < HOURS; h++) {
      const r = G.settleFarming({
        character: { classId: c, level: 38, xp: 0 },
        equipment: kitItems,
        areaId: 'cinderDepths',
        seed: `b5-loot:${c}:${h}`,
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      });
      farmDrops.push(...r.items);
      legs += r.items.filter((i) => i.rarityId === 'legendary' && i.itemLevel >= MIN_IL).length;
    }
    const perHour = count(farmDrops, HOURS);
    const dungeon = (
      d: G.DungeonId,
      tier: G.DungeonTier,
      level: number,
      hoard: boolean,
      n: number,
    ) => {
      const drops: G.GeneratedItem[] = [];
      for (let i = 0; i < n; i++) {
        const r = G.simulateDungeonRun({
          dungeonId: d,
          tier,
          character: { classId: c, level, xp: 0 },
          equipment: kitItems,
          seed: `b5-loot:${d}:${hoard}:${i}`,
          bossLootEligible: hoard,
          inventoryCount: 0,
        });
        drops.push(...r.items);
      }
      return count(drops, n);
    };
    const heroicRun = dungeon('namelessCrypt', 4, 36, false, RUNS * 10);
    const heroicHoardRun = dungeon('namelessCrypt', 4, 36, true, RUNS * 10);
    const tyrantHoard = dungeon('tyrantsForge', 1, 38, true, RUNS * 10);
    const dayRate = (heroic: boolean) =>
      needs.map(
        (_, k) =>
          15 * perHour[k]! +
          tyrantHoard[k]! +
          (heroic ? 4 * heroicRun[k]! + heroicHoardRun[k]! : 0),
      );
    const rng = G.createRng(`b5-loot-trials:${c}`);
    const sample = (rates: number[]) => {
      const out: number[] = [];
      for (let t = 0; t < TRIALS; t++) {
        let worst = 0;
        for (const r of rates)
          worst = Math.max(worst, r > 0 ? -Math.log(1 - rng.next()) / r : Infinity);
        out.push(worst);
      }
      out.sort((a, b) => a - b);
      return { median: out[TRIALS >> 1]!, p90: out[Math.floor(TRIALS * 0.9)]! };
    };
    const withH = sample(dayRate(true));
    const without = sample(dayRate(false));
    console.log(`${c}: ${describeBuild(top)}`);
    console.log(
      `  per needed piece and day (farming · Tyrant hoard · Heroic): ${needs.map((n, k) => `${n.key} ${(15 * perHour[k]!).toFixed(2)}·${tyrantHoard[k]!.toFixed(2)}·${(4 * heroicRun[k]! + heroicHoardRun[k]!).toFixed(2)}`).join(', ')}`,
    );
    console.log(
      `  Legendaries (il ${MIN_IL}+) per farming hour ${(legs / HOURS).toFixed(2)}; days to the build: with Heroic median ${withH.median.toFixed(0)} (p90 ${withH.p90.toFixed(0)}), without ${without.median.toFixed(0)} (p90 ${without.p90.toFixed(0)})${ringEffects.length ? '' : ''}`,
    );
  }
}

/**
 * `forgeward`: 6.7's open point, measured: would a big town need a lower first-day cap (10 %, so
 * ten givers) on the Forgeward Outpost? The realistic town (`largeTown`) at 20/100/500 players
 * with 6.7's cap (20 % on the first day) and with 10 % on every stage (shipped in ticket B.5b).
 */
if (mode === 'forgeward') {
  const { largeTown, playTown } =
    await import('../../packages/game-core/src/balance/community-town.ts');
  const def = G.findCommunityProject('forgewardOutpost')!;
  for (const cap of [0.2, 0.1]) {
    const project = { ...def, stages: def.stages.map((s) => ({ ...s, capShare: cap })) };
    for (const n of [20, 100, 500]) {
      const r = playTown(largeTown(n), G.COMMUNITY_PROJECT_CONFIG, [project], 200);
      console.log(
        `cap ${cap} · ${n} players: done day ${(r.at(-1)?.doneOn ?? NaN) + 1} · stage days ${r.map((x) => x.doneOn - x.firstDay + 1).join('/')} · givers ${r.map((x) => x.givers).join('/')} · first-day givers ${r.map((x) => (x as { firstDayGivers?: number }).firstDayGivers ?? '?').join('/')} · top share ${r.map((x) => Math.round(x.topGiverShare * 100)).join('/')} %`,
      );
    }
  }
}

/**
 * `event`: the Harvest of Bones (6.6) for three heroes: a newcomer (level 6, no gear) and a
 * mid-game hero (level 20, rares +5) in the Abandoned Fields, and an endgame hero (level 40, the
 * realistic +5 Legendary kit at item level 38) in the Old Burial Grounds (the most risen a minute)
 * against its usual Depths farming. Per farmed hour: risen put down, the bounty (one Soul Shard
 * per 40), the area's own shards, gold and XP; and the hours to the event's farming tasks.
 */
if (mode === 'event') {
  const def = G.getEventDefinition('harvestOfBones');
  const mod = def.modifier as unknown as { enemyIds: readonly string[]; every: number };
  const risen = new Set(mod.enemyIds);
  const farm = (c: G.ClassId, level: number, eq: G.EquippedItem[], areaId: G.AreaId) => {
    let kills = 0,
      r = 0,
      shards = 0,
      gold = 0,
      xp = 0;
    const H = 4;
    for (let h = 0; h < H; h++) {
      const s = G.settleFarming({
        character: { classId: c, level, xp: 0 },
        equipment: eq,
        areaId,
        seed: `b5-event:${c}:${level}:${areaId}:${h}`,
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      });
      kills += s.kills;
      r += Object.entries(s.killsByEnemy)
        .filter(([e]) => risen.has(e))
        .reduce((a, [, n]) => a + (n ?? 0), 0);
      shards += s.materials.soulShard ?? 0;
      gold += s.goldLooted + s.goldSalvaged;
      xp += s.xpGained;
    }
    return {
      kills: kills / H,
      risen: r / H,
      bounty: Math.floor(r / H / mod.every),
      shards: shards / H,
      gold: gold / H,
      xp: xp / H,
    };
  };
  const heroes: [string, number, (c: G.ClassId) => G.EquippedItem[], G.AreaId][] = [
    ['newcomer 6, no gear', 6, () => [], 'abandonedFields'],
    ['mid-game 20, rares +5', 20, (c) => upgraded(kit(c, 19, 'rare'), 5), 'abandonedFields'],
    [
      'endgame 40, Legendaries +5',
      40,
      (c) => upgraded(legendarySample(c, 38, 0), 5),
      'oldBurialGrounds',
    ],
  ];
  for (const [label, level, eq, areaId] of heroes) {
    for (const c of G.CLASS_IDS) {
      const f = farm(c, level, eq(c), areaId);
      const furrows = 60 / f.risen;
      const tithe = 12 / (f.shards + f.bounty);
      const reaping = 400 / f.kills;
      let usual = '';
      if (level === 40) {
        const d = farm(c, 40, eq(c), 'cinderDepths');
        usual = ` · Depths instead: ${Math.round(d.shards)} shards, ${Math.round(d.gold)} g, ${Math.round(d.xp / 1000)}k XP`;
      }
      console.log(
        `${label.padEnd(28)} ${c.padEnd(8)} ${areaId}: ${Math.round(f.kills)} kills/h (${Math.round(f.risen)} risen) · bounty ${f.bounty} + own ${f.shards.toFixed(1)} shards · ${Math.round(f.gold)} g · ${Math.round(f.xp / 1000)}k XP · Furrows ${(furrows * 60).toFixed(0)} min, Tithe ${(tithe * 60).toFixed(0)} min, Reaping ${(reaping * 60).toFixed(0)} min${usual}`,
      );
    }
  }
}

/**
 * `procession`: the Lantern Procession (8.3) for a newcomer (level 6, no gear, the Fields), a
 * level-12 hero (uncommons +2, Crowwood), a mid-game hero (20, rares +5, the Sunken Abbey) and
 * endgame heroes (40 in the Depths, 46 in the Pale Marches, Legendaries +5): kills and gathered
 * materials an hour, the ore bonus, and per week the hours its farming tasks take (the slower of
 * the kill and the gathering task; the bonus ore counts for gathering, the deeper road's kills
 * count for both kill tasks where the hero farms the Cinderwastes or the Hollow Reach).
 */
if (mode === 'procession') {
  const def = G.getEventDefinition('lanternProcession');
  const mod = def.modifier as unknown as { materialIds: readonly string[]; every: number };
  const counted = new Set(mod.materialIds);
  const heroes: [string, number, (c: G.ClassId) => G.EquippedItem[], G.AreaId][] = [
    ['newcomer 6, no gear', 6, () => [], 'abandonedFields'],
    ['early 12, uncommons +2', 12, (c) => upgraded(kit(c, 11, 'uncommon'), 2), 'crowwood'],
    ['mid-game 20, rares +5', 20, (c) => upgraded(kit(c, 19, 'rare'), 5), 'sunkenAbbey'],
    [
      'endgame 40, Legendaries +5',
      40,
      (c) => upgraded(legendarySample(c, 38, 0), 5),
      'cinderDepths',
    ],
    [
      'endgame 46, Legendaries +5',
      46,
      (c) => upgraded(legendarySample(c, 44, 0), 5),
      'paleMarches',
    ],
  ];
  const week = (w: number, kind: 'kill' | 'gatherAny', deep: boolean) =>
    def.quests.find(
      (q) =>
        (q.week ?? 1) === w && q.objective.kind === kind && (q.minLevel !== undefined) === deep,
    )?.objective.count ?? 0;
  for (const [label, level, eq, areaId] of heroes) {
    for (const c of G.CLASS_IDS) {
      let kills = 0,
        gathered = 0;
      const H = 3;
      for (let h = 0; h < H; h++) {
        const s = G.settleFarming({
          character: { classId: c, level, xp: 0 },
          equipment: eq(c),
          areaId,
          seed: `8.3-procession:${c}:${level}:${areaId}:${h}`,
          firstCycle: 0,
          durationMs: 3_600_000,
          inventoryCount: 0,
        });
        kills += s.kills;
        for (const [m, n] of Object.entries(s.materials)) if (counted.has(m)) gathered += n ?? 0;
      }
      const k = kills / H;
      const g = gathered / H;
      const ore = g / mod.every;
      const hours = [1, 2, 3, 4].map((w) => {
        const t = Math.max(week(w, 'kill', false) / k, week(w, 'gatherAny', false) / (g + ore));
        return t.toFixed(1);
      });
      const deep =
        level >= 28
          ? ` · deeper road kills ${[2, 4].map((w) => (week(w, 'kill', true) / k).toFixed(1)).join(' / ')} h (weeks 2 / 4)`
          : '';
      console.log(
        `${label.padEnd(28)} ${c.padEnd(8)} ${areaId}: ${Math.round(k)} kills/h · ${g.toFixed(0)} gathered/h · ${ore.toFixed(1)} ore/h · open road per week ${hours.join(' / ')} h${deep}`,
      );
    }
  }
}

/**
 * `older`: the Phase 6 exit criterion "older drops keep a use". (1) Salvage and the Forge: what an
 * Ashen Pass Legendary (item level 25, tier 3) salvages to, against the expected materials of one
 * Depths item's +0 → +10 path (item level 39). (2) Set completion: each class's best build at +10
 * Void with its set pieces from the Pass (item level 25) and the rest from the Depths (39), against
 * all from the Depths, all from the Verge (33) and all from the Pass: Depths farming at 40
 * (kills/min) and the Forge Tyrant at 38 (win rate, mean kill time).
 */
if (mode === 'older') {
  const { upgradePathCost } = await import('../../packages/game-core/src/economy/forgeActions.ts');
  const { salvageYield } = await import('../../packages/game-core/src/economy/forge.ts');
  const old = G.generateItem({
    seed: 1,
    itemLevel: 25,
    baseId: 'knights-plate' as G.ItemBaseId,
    rarityId: 'legendary',
    classId: 'warrior',
  })!;
  const y = salvageYield(old);
  const path = upgradePathCost(
    { baseId: 'ashplate-hauberk' as G.ItemBaseId, itemLevel: 39 },
    0,
    10,
  );
  console.log(`salvage of a Pass Legendary (il 25): ${y.gold} g, ${JSON.stringify(y.materials)}`);
  console.log(
    `a Depths item's +0 → +10 (il 39, expected): ${Math.round(path.expected.gold)} g, ${JSON.stringify(Object.fromEntries(Object.entries(path.expected.materials).map(([k, v]) => [k, Math.round(v as number)])))}`,
  );
  for (const [k, v] of Object.entries(path.expected.materials)) {
    const per = (y.materials as Record<string, number>)[k] ?? 0;
    console.log(
      `  ${k}: ${per ? ((v as number) / per).toFixed(1) : '—'} Pass Legendaries' salvage per +10 path`,
    );
  }
  for (const c of G.CLASS_IDS) {
    const top = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    )[0]!.build;
    const at = (il: number) => buildItems({ ...top, upgradeLevel: 10, void: true }, il);
    const depths = at(39);
    const mixed = depths.map((i, k) => (i.setId ? at(25)[k]! : i));
    const kits: [string, G.EquippedItem[]][] = [
      ['all Depths (39)', depths],
      ['Pass set pieces + Depths', mixed],
      ['all Verge (33)', at(33)],
      ['all Pass (25)', at(25)],
    ];
    const cells = kits.map(([label, eq]) => {
      const kpm = farmRate(c, eq, {
        ...PASS_FARM_JOB,
        areaId: 'cinderDepths',
        level: 40,
        itemLevel: 39,
      });
      const b = run('tyrantsForge', 1, c, 38, eq, RUNS);
      return `${label} ${kpm.toFixed(1)}/min, Tyrant ${pct(b.rate)}% ${b.mean.toFixed(0)}s`;
    });
    console.log(`${c}: ${cells.join(' · ')}`);
  }
}

if (mode === 'sinks') {
  // Ticket 6.11 (docs/BALANCE.md "6.11"). Rates as `awakening.ts time` (Verge Legendaries +10 at
  // 38, five tries a day at each hoard); the season model is game-core's `sealFlow`.
  const { legendaryKit } = await import('../../packages/game-core/src/balance/kits.ts');
  const { buildSlots } = await import('../../packages/game-core/src/balance/builds.ts');
  const { sealFlow } = await import('../../packages/game-core/src/balance/seal-flow.ts');
  const { DEFAULT_AWAKENING_SETTINGS } =
    await import('../../packages/game-core/src/items/awakening.ts');
  const SEASON = Number(process.env.SEASON_DAYS ?? 56);
  const N = Number(process.env.TRIES ?? 40);
  const HOURS_A_DAY = 15;
  const k = DEFAULT_AWAKENING_SETTINGS.cost;
  const prices = {
    awakenSeals: k.gravewardenSeal,
    awakenEmbers: k.tyrantsEmber,
    exchange: G.COSMETIC_EXCHANGE.map((o) => ({
      seals: o.price.gravewardenSeal ?? 0,
      silver: o.price.abbeySilver ?? 0,
    })),
    engraveSeals: G.ENGRAVING_PRICES.seal.gravewardenSeal ?? 0,
    engraveSilver: G.ENGRAVING_PRICES.silver.abbeySilver ?? 0,
  };
  console.log(
    `## 6.11 sinks: exchange ${prices.exchange.reduce((s, o) => s + o.seals, 0)} Seals + ${prices.exchange.reduce((s, o) => s + o.silver, 0)} silver once; engraving ${prices.engraveSeals} Seals or ${prices.engraveSilver} silver each; season ${SEASON} days`,
  );
  // Abbey silver: a dedicated hero farms the Sunken Abbey from 17 to 23 (where the crypt's tier
  // III and the Pass take over) in Epic gear two levels below; silver is only gathered there.
  for (const c of G.CLASS_IDS) {
    const items = upgraded(kit(c, 18, 'epic'), 5);
    let level = 17;
    let xp = 0;
    let hours = 0;
    let silver = 0;
    let professions: G.SettleFarmingInput['professions'] = undefined;
    while (level < 23 && hours < 200) {
      const r = G.settleFarming({
        character: { classId: c, level, xp },
        equipment: items,
        areaId: 'sunkenAbbey',
        seed: `b611-silver:${c}:${hours}`,
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
        ...(professions ? { professions } : {}),
      });
      level = r.level;
      xp = r.xp;
      professions = r.professions;
      silver += r.materials.abbeySilver ?? 0;
      hours += 1;
    }
    console.log(
      `${c}: Abbey 17 → 23 in ${hours} h of farming (${(hours / HOURS_A_DAY).toFixed(1)} dedicated days), ${silver} Abbey silver (${(silver / hours).toFixed(1)}/h)`,
    );
  }
  console.log('');
  console.log(
    '| class | Embers/day | Seals/day (+ guild 2/week) | before: kit day · spare Seals at kit · at season end | after: kit day · spare Seals at kit (to sinks by then) · season: Seals to sinks · engravings · Seals left · silver left |',
  );
  console.log('|---|---|---|---|---|');
  for (const c of G.CLASS_IDS) {
    const items = upgraded(legendaryKit(c, 33), 10);
    const win = (dungeonId: G.DungeonId, tier: G.DungeonTier) => {
      let w = 0;
      for (let i = 0; i < N; i++)
        if (
          G.simulateDungeonRun({
            dungeonId,
            tier,
            character: { classId: c, level: 38, xp: 0 },
            equipment: items,
            seed: `awakening-time:${dungeonId}:${i}`,
            bossLootEligible: false,
            inventoryCount: 0,
          }).bossDefeated
        )
          w++;
      return w / N;
    };
    const perDay = (p: number) => 1 - (1 - p) ** 5;
    const embersPerDay = perDay(win('tyrantsForge', 1));
    const sealsPerDay = perDay(Math.max(win('namelessCrypt', 4), win('namelessCrypt', 3)));
    const pieces = buildSlots(c).length;
    const silverStock = Number(process.env.SILVER ?? 150);
    const base = {
      days: SEASON,
      sealsPerDay,
      guildSealsPerWeek: 2,
      embersPerDay,
      pieces,
      silverStock,
      prices,
    };
    const before = sealFlow({ ...base, sinks: false });
    const after = sealFlow({ ...base, sinks: true });
    const f = (x: number | null) => (x === null ? '—' : x.toFixed(1));
    console.log(
      `| ${c} (${pieces}) | ${embersPerDay.toFixed(2)} | ${sealsPerDay.toFixed(2)} + 0.29 | day ${before.kitDay ?? '—'} · ${f(before.spareAtKit)} · ${before.sealsLeft.toFixed(1)} | day ${after.kitDay ?? '—'} · ${f(after.spareAtKit)} (${after.sinkSealsAtKit ?? '—'}) · ${after.sealsToSinks} (${after.exchangeBought} offers) · ${after.engravings} · ${after.sealsLeft.toFixed(1)} · ${after.silverLeft} of ${silverStock} |`,
    );
  }
}
