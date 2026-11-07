// Ticket B.3: the top end measured with upgrades and Void. Dev script; guards in balance/*.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/top-end.ts pass|tier3
//   pass:  the top Ashen Pass builds at +0, +5, +10 and +10 Void (kills/min at 26 and 28)
//   tier3: crypt tier III at 21–23 with mixed Legendary/set kits at +3–6 (win rate, boss time)
import * as G from '../../packages/game-core/src/index.ts';
import {
  PASS_FARM_JOB,
  BOSS_JOB,
  bossTime,
  buildItems,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
  topBuilds,
} from '../../packages/game-core/src/balance/builds.ts';

const mode = process.argv[2] ?? 'pass';
if (mode === 'pass') {
  for (const c of G.CLASS_IDS) {
    const scored = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    );
    const top = topBuilds(scored, 0.07).slice(0, 3);
    for (const t of top) {
      const row = [26, 28].flatMap((level) =>
        [
          [0, false],
          [5, false],
          [10, false],
          [10, true],
        ].map(([u, v]) =>
          farmRate(
            c,
            buildItems({ ...t.build, upgradeLevel: u as number, void: v as boolean }, level - 1),
            { ...PASS_FARM_JOB, level, itemLevel: level - 1 },
          ).toFixed(1),
        ),
      );
      console.log(
        `${c} ${describeBuild(t.build)}: L26 ${row.slice(0, 4).join('/')}  L28 ${row.slice(4).join('/')}`,
      );
    }
  }
}
if (mode === 'tier3') {
  // Mixed kits: a chassis of sets plus Legendaries, upgraded, at the tier's entry.
  const N = Number(process.env.N ?? 24);
  for (const c of G.CLASS_IDS) {
    const scored = searchBuilds(
      c,
      BOSS_JOB.itemLevel,
      (items) => -bossTime(c, items, 8),
      setChassis(c),
      false,
    );
    const builds = [scored[0]!, scored[Math.floor(scored.length / 2)]!, scored.at(-1)!];
    for (const s of builds) {
      for (const level of [21, 22, 23]) {
        const row = [0, 3, 6].map((u) => {
          const items = buildItems({ ...s.build, upgradeLevel: u }, level - 1);
          let w = 0;
          let t = 0;
          for (let i = 0; i < N; i++) {
            const r = G.simulateDungeonRun({
              dungeonId: 'namelessCrypt',
              tier: 3,
              character: { classId: c, level, xp: 0 },
              equipment: items,
              seed: `b3:${i}`,
              bossLootEligible: false,
              inventoryCount: 0,
            });
            const b = r.encounters.at(-1)!;
            if (r.bossDefeated) {
              w++;
              t += b.endMs - b.startMs;
            }
          }
          return `+${u} ${Math.round((100 * w) / N)}% ${w ? (t / w / 1000).toFixed(0) : '-'}s`;
        });
        console.log(`${c} L${level} ${describeBuild(s.build).slice(0, 50)}: ${row.join(' | ')}`);
      }
    }
  }
}
if (mode === 'overlevel') {
  // Heroes keep levelling past the Pass (cap 60): the best Pass builds at item level 27, +10 Void.
  for (const c of G.CLASS_IDS) {
    const scored = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    );
    const best = scored[0]!.build;
    const row = [26, 28, 30, 32, 35, 38].map((level) => {
      const items = buildItems({ ...best, upgradeLevel: 10, void: true }, 27);
      const k = farmRate(c, items, { ...PASS_FARM_JOB, level, itemLevel: 27 });
      const xp = G.settleFarming({
        character: { classId: c, level, xp: 0 },
        equipment: items,
        areaId: 'ashenPass',
        seed: 'ol',
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      }).xpGained;
      return `L${level} ${k.toFixed(1)}k ${(xp / 1000).toFixed(0)}kxp/h ${((700 * level * level) / xp).toFixed(1)}h/lvl`;
    });
    console.log(`${c}: ${row.join(' | ')}`);
  }
}
