import { describe, expect, it } from 'vitest';
import {
  CADENCE_MAX_MS,
  CADENCE_MIN_MS,
  FRAMED_IMPACT_MS,
  LUNGE_IMPACT_MS,
  SceneLoop,
  cuesSince,
  planFor,
  seededRandom,
  type SceneBeat,
} from './sceneLoop';

/** Runs a loop to `until` ms, one step per scheduled beat (as the driver's single timer does). */
function run(loop: SceneLoop, until: number) {
  const out: { at: number; beat: SceneBeat }[] = [];
  for (let at = loop.nextAt(); at <= until; at = loop.nextAt()) {
    out.push(...loop.advance(at));
  }
  return out;
}

describe('planFor (A.14 cadence)', () => {
  it('swings more often for a faster hero, within the calm bounds', () => {
    const slow = planFor({ attackSpeed: 0.85, foes: 3 });
    const fast = planFor({ attackSpeed: 1.25, foes: 3 });
    expect(fast.cadenceMs).toBeLessThan(slow.cadenceMs);
    for (const speed of [0.25, 0.85, 1, 1.25, 4, 40]) {
      const { cadenceMs } = planFor({ attackSpeed: speed, foes: 3 });
      expect(cadenceMs).toBeGreaterThanOrEqual(CADENCE_MIN_MS);
      expect(cadenceMs).toBeLessThanOrEqual(CADENCE_MAX_MS);
    }
  });

  it('falls back to a fixed cadence without usable stats', () => {
    for (const attackSpeed of [null, undefined, 0, -1, Number.NaN, Infinity]) {
      expect(planFor({ attackSpeed, foes: 2 }).cadenceMs).toBe(1600);
    }
  });

  it('lands the blow later when the hero swings with frames', () => {
    expect(planFor({ foes: 1 }).impactMs).toBe(LUNGE_IMPACT_MS);
    expect(planFor({ foes: 1, framed: true }).impactMs).toBe(FRAMED_IMPACT_MS);
  });

  it("times each foe's blow by its own attack, not the hero's (A.14b)", () => {
    const plan = planFor({ foes: 3, framed: true, framedFoes: [true, false, true] });
    expect(plan.foeImpactMs).toEqual([FRAMED_IMPACT_MS, LUNGE_IMPACT_MS, FRAMED_IMPACT_MS]);
    expect(planFor({ foes: 2, framed: true }).foeImpactMs).toEqual([
      LUNGE_IMPACT_MS,
      LUNGE_IMPACT_MS,
    ]);
  });
});

describe('SceneLoop (A.14)', () => {
  const plan = planFor({ attackSpeed: 1, foes: 3 });

  it('is a pure schedule: the same random source gives the same beats', () => {
    const a = run(new SceneLoop(plan, seededRandom(7)), 60_000);
    const b = run(new SceneLoop(plan, seededRandom(7)), 60_000);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(30);
  });

  // Every invariant below is checked over many seeds: it must hold for every outcome.
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

  it('follows every hero swing with a hit on the same foe, one impact later', () => {
    for (const seed of seeds) {
      const beats = run(new SceneLoop(plan, seededRandom(seed)), 30_000);
      beats.forEach(({ at, beat }, i) => {
        // A swing at the very end of the run has its blow land after the run stops.
        if (beat.kind !== 'heroStrike' || at > 29_000) return;
        const hit = beats.slice(i + 1).find((b) => b.beat.kind === 'foeHit');
        expect(hit?.beat, `seed ${seed}`).toMatchObject({ kind: 'foeHit', foe: beat.foe });
        expect(hit!.at - at).toBe(plan.impactMs);
      });
    }
  });

  it('never strikes, or is struck by, a foe that is down, and raises every fallen foe', () => {
    for (const seed of seeds) {
      const down = new Set<number>();
      for (const { beat } of run(new SceneLoop(plan, seededRandom(seed)), 40_000)) {
        if (beat.kind === 'foeFall') {
          expect(down.has(beat.foe)).toBe(false);
          down.add(beat.foe);
        } else if (beat.kind === 'foeRise') {
          expect(down.delete(beat.foe)).toBe(true);
        } else if ('foe' in beat) {
          expect(down.has(beat.foe), `seed ${seed}: ${beat.kind} on a fallen foe`).toBe(false);
        }
        if ('foe' in beat) expect(beat.foe).toBeLessThan(plan.foes);
      }
      // At most the last foe felled is still down when the run stops.
      expect(down.size).toBeLessThanOrEqual(1);
    }
  });

  it('fells a foe after two to four blows and keeps it down for the respawn time', () => {
    for (const seed of seeds) {
      const beats = run(new SceneLoop(plan, seededRandom(seed)), 30_000);
      let blows = 0;
      for (const [i, { at, beat }] of beats.entries()) {
        if (beat.kind === 'foeHit') blows += 1;
        if (beat.kind !== 'foeFall') continue;
        expect(blows).toBeGreaterThanOrEqual(2);
        expect(blows).toBeLessThanOrEqual(4);
        blows = 0;
        const rise = beats.slice(i).find((b) => b.beat.kind === 'foeRise');
        if (rise) expect(rise.at - at).toBe(Math.round(plan.respawnMs));
      }
    }
  });

  it('keeps the swing rhythm within ±10 % of the cadence', () => {
    for (const seed of seeds.slice(0, 50)) {
      const swings = run(new SceneLoop(plan, seededRandom(seed)), 60_000)
        .filter((b) => b.beat.kind === 'heroStrike')
        .map((b) => b.at);
      for (let i = 1; i < swings.length; i++) {
        const gap = swings[i]! - swings[i - 1]!;
        expect(gap).toBeGreaterThanOrEqual(Math.floor(plan.cadenceMs * 0.9));
        expect(gap).toBeLessThanOrEqual(Math.ceil(plan.cadenceMs * 1.1));
      }
    }
  });

  it('lets a foe answer now and then, followed by the hero flinching', () => {
    let answers = 0;
    for (const seed of seeds) {
      const beats = run(new SceneLoop(plan, seededRandom(seed)), 30_000);
      beats.forEach(({ at, beat }, i) => {
        if (beat.kind !== 'foeStrike' || at > 29_000) return;
        answers += 1;
        const flinch = beats.slice(i + 1).find((b) => b.beat.kind === 'heroHit');
        expect(flinch!.at - at).toBe(plan.foeImpactMs[beat.foe]);
      });
    }
    // Across 200 seeds × 30 s the answer always appears (its odds per swing pair are 45 %).
    expect(answers).toBeGreaterThan(0);
  });

  it('waits for a single foe to rise before swinging again', () => {
    const one = planFor({ attackSpeed: 1, foes: 1 });
    for (const seed of seeds.slice(0, 50)) {
      let downUntil = -1;
      for (const { at, beat } of run(new SceneLoop(one, seededRandom(seed)), 30_000)) {
        if (beat.kind === 'foeFall') downUntil = at + Math.round(one.respawnMs);
        if (beat.kind === 'heroStrike') expect(at).toBeGreaterThanOrEqual(downUntil);
      }
    }
  });

  it('plays nothing in an empty room', () => {
    const loop = new SceneLoop(planFor({ foes: 0 }), seededRandom(1));
    expect(loop.nextAt()).toBe(Infinity);
    expect(loop.advance(60_000)).toEqual([]);
  });

  it('turns chronicle cues into flavour: a kill fells a foe within the next two swings', () => {
    // The loop plans one swing ahead, so a kill cue lands on the first swing not yet planned.
    for (const seed of seeds.slice(0, 50)) {
      const loop = new SceneLoop(plan, seededRandom(seed));
      const first = loop.nextAt();
      loop.cue('kill', first - 1);
      const kinds = run(loop, first + Math.ceil(plan.cadenceMs * 1.1) + plan.impactMs + 200).map(
        (b) => b.beat.kind,
      );
      expect(kinds.filter((k) => k === 'heroStrike')).toHaveLength(2);
      expect(kinds, `seed ${seed}`).toContain('foeFall');
    }
  });

  it('glows the hero on a level-up and flinches it on a death, at the cue time', () => {
    const loop = new SceneLoop(plan, seededRandom(3));
    loop.cue('level', 10);
    loop.cue('death', 20);
    expect(loop.advance(25)).toEqual([
      { at: 10, beat: { kind: 'heroGlow' } },
      { at: 20, beat: { kind: 'heroHit' } },
    ]);
  });
});

describe('cuesSince', () => {
  const log = [
    { id: 'e5', kind: 'level' },
    { id: 'e4', kind: 'loot' },
    { id: 'e3', kind: 'kill' },
    { id: 'e2', kind: 'death' },
    { id: 'e1', kind: 'kill' },
  ];

  it('returns kills, level-ups and deaths newer than the last seen entry, oldest first', () => {
    expect(cuesSince(log, 'e2')).toEqual(['kill', 'level']);
    expect(cuesSince(log, 'e5')).toEqual([]);
  });

  it('replays nothing when the screen has just opened', () => {
    expect(cuesSince(log, null)).toEqual([]);
  });
});
