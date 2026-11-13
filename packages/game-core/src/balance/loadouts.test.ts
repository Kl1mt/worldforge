import { describe, expect, it } from 'vitest';
import { defaultLoadout, loadoutKey, settleFarming, type ClassId } from '../index.js';
import {
  BOSS_JOBS,
  CLASS_IDS,
  FARM_JOBS,
  allLoadouts,
  bossTime,
  farmRate,
  scoreAll,
  viable,
  withSkillsPrototype,
  type ScoredLoadout,
} from './loadouts.js';

/**
 * Ticket 9.1: the loadout build search (docs/SKILLS.md "Measurements"; numbers from
 * `tools/balance/loadouts.ts search`). Every loadout a hero can field on today's farming and boss
 * jobs, with the skills prototype on. Every settlement and run draws from a fixed seed, so each
 * number is a measurement that is the same in every run; a band fails only when a rule, a skill or
 * content changes.
 */
const SLOW = { timeout: 300_000 };

/** A loadout's skills, ignoring the priority order of slots 2 and 3 (B.2's "distinct"). */
const distinct = (list: ScoredLoadout[]) =>
  new Set(
    list.map((s) => {
      const [core, ...rest] = s.loadout.actives;
      return `${core}|${rest.filter(Boolean).sort().join(',')}|${s.loadout.passive ?? ''}`;
    }),
  ).size;

const scores = new Map<string, ScoredLoadout[]>();
function measured(c: ClassId, jobId: string): ScoredLoadout[] {
  const key = `${c}:${jobId}`;
  if (!scores.has(key)) {
    const farm = FARM_JOBS.find((j) => j.id === jobId);
    const boss = BOSS_JOBS.find((j) => j.id === jobId);
    const job = (farm ?? boss)!;
    scores.set(
      key,
      withSkillsPrototype(() =>
        scoreAll(c, allLoadouts(c, job.hero), (l) =>
          farm ? farmRate(c, farm, l) : -bossTime(c, boss!, l).time,
        ),
      ),
    );
  }
  return scores.get(key)!;
}
const ratio = (list: ScoredLoadout[], c: ClassId) => {
  const def = list.find((s) => s.key === loadoutKey(defaultLoadout(c)))!;
  const best = list[0]!;
  return best.score > 0 ? best.score / def.score : def.score / best.score;
};

describe('loadouts: at least three viable per class and job (9.1)', () => {
  for (const c of CLASS_IDS) {
    it(
      `${c}: three distinct loadouts within 7 % of the best on every job; sidegrades`,
      SLOW,
      () => {
        for (const job of [...FARM_JOBS, ...BOSS_JOBS]) {
          const list = measured(c, job.id);
          const label = `${job.id}: ${list
            .slice(0, 5)
            .map((s) => `${s.key} ${Math.abs(s.score).toFixed(2)}`)
            .join(' · ')}`;
          expect(distinct(viable(list)), label).toBeGreaterThanOrEqual(3);
          // Sidegrades, not a new power curve: the best loadout of a job against the default one
          // (today). Measured farming × 1.06–1.15, boss times × 1.06–1.19 faster; the mage's boss
          // times × 1.30–1.55 because they include losses (150 s): a little more damage turns the
          // mage's lost fights (B.5: the weakest boss class) into wins (docs/SKILLS.md).
          const r = ratio(list, c);
          expect(r, label).toBeGreaterThan(1.03);
          const farming = FARM_JOBS.some((j) => j.id === job.id);
          expect(r, label).toBeLessThan(farming ? 1.18 : c === 'mage' ? 1.6 : 1.22);
        }
      },
    );
  }
});

describe('loadouts: none leads both farming and bosses (9.1)', () => {
  // The tiers where the whole kit is unlocked (36+). Below, with two or three spenders, a hero has
  // fewer real choices: measured, not asserted (docs/SKILLS.md).
  const pairs: [string, string][] = [
    ['depths37', 'tyrant38'],
    ['deep49', 'sovereign50'],
  ];
  for (const c of CLASS_IDS) {
    it(
      `${c}: no loadout within 2 % of both bests; each leader ≥ 3 % behind on the other`,
      SLOW,
      () => {
        for (const [farmId, bossId] of pairs) {
          const f = measured(c, farmId);
          const b = measured(c, bossId);
          const keys = new Set(b.map((x) => x.key));
          const fb = f.filter((x) => keys.has(x.key));
          const bb = b.filter((x) => fb.some((y) => y.key === x.key));
          const lf = new Set(viable(fb, 0.02).map((x) => x.key));
          const both = viable(bb, 0.02).filter((x) => lf.has(x.key));
          expect(
            both.map((x) => x.key),
            `${farmId} × ${bossId}`,
          ).toEqual([]);
          const at = (list: ScoredLoadout[], key: string) => list.find((x) => x.key === key)!.score;
          const behind = (list: ScoredLoadout[], key: string) =>
            Math.abs(list[0]!.score / at(list, key) - 1);
          expect(behind(bb, fb[0]!.key), `${c} farm leader at ${bossId}`).toBeGreaterThan(0.03);
          expect(behind(fb, bb[0]!.key), `${c} boss leader at ${farmId}`).toBeGreaterThan(0.03);
        }
      },
    );
  }
});

describe('loadouts stay inside today’s farming bands (9.1)', () => {
  it(
    'the five best farming loadouts per class: no deaths at the Hollow Deep, 6–13 kills a minute',
    SLOW,
    () => {
      const deep = FARM_JOBS.find((j) => j.id === 'deep49')!;
      for (const c of CLASS_IDS) {
        for (const s of measured(c, 'deep49').slice(0, 5)) {
          const r = withSkillsPrototype(() =>
            settleFarming({
              character: { classId: c, level: deep.level, xp: 0 },
              equipment: deep.gear(c),
              areaId: deep.areaId,
              seed: 'l9-band',
              firstCycle: 0,
              durationMs: 3_600_000,
              inventoryCount: 0,
              loadout: s.loadout,
            }),
          );
          // The 8.2 bands for the best Marches gear (docs/COMBAT.md "The Hollow Deep").
          expect(r.deaths, `${c} ${s.key}`).toBe(0);
          expect(r.kills / 60, `${c} ${s.key}`).toBeGreaterThan(6);
          expect(r.kills / 60, `${c} ${s.key}`).toBeLessThan(13);
        }
      }
    },
  );
});
