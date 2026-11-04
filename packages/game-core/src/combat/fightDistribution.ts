import type { Rng } from '../rng.js';
import type { EncounterSetup, FightOutcome } from './encounter.js';
import { hitsToDie } from './encounter.js';

/**
 * Exact probability distribution of the number of character attacks needed to
 * kill the enemy, for attacks 1..floor(maxFightMs / playerIntervalMs).
 * `probabilities[n]` = P(kill on attack n); index 0 is unused. The remaining
 * mass is the probability of not killing the enemy in time.
 *
 * Dynamic programming over the total damage dealt so far: each attack's damage
 * is one of two integers, so equal totals merge and the state space stays small.
 */
export function hitsToKillDistribution(setup: EncounterSetup): Float64Array {
  const maxAttacks = Math.floor(setup.maxFightMs / setup.playerIntervalMs);
  const probabilities = new Float64Array(maxAttacks + 1);
  let states = new Map<number, number>([[0, 1]]);
  for (let attack = 1; attack <= maxAttacks && states.size > 0; attack++) {
    const hit = attack % setup.skillEvery === 0 ? setup.skill : setup.auto;
    const outcomes: [number, number][] = [
      [hit.normal, 1 - hit.critChance],
      [hit.crit, hit.critChance],
    ];
    const next = new Map<number, number>();
    for (const [dealt, p] of states) {
      for (const [damage, q] of outcomes) {
        if (q <= 0) continue;
        const total = dealt + damage;
        const pq = p * q;
        if (total >= setup.enemyHealth) {
          probabilities[attack] = (probabilities[attack] ?? 0) + pq;
        } else {
          next.set(total, (next.get(total) ?? 0) + pq);
        }
      }
    }
    states = next;
  }
  return probabilities;
}

/** Cache key of everything `hitsToKillDistribution` depends on. */
export function distributionKey(s: EncounterSetup): string {
  return [
    s.enemyHealth,
    s.playerIntervalMs,
    s.maxFightMs,
    s.skillEvery,
    s.auto.normal,
    s.auto.crit,
    s.auto.critChance,
    s.skill.normal,
    s.skill.crit,
    s.skill.critChance,
  ].join('|');
}

/**
 * Resolves a fight with a single RNG draw: samples the killing attack from the
 * exact distribution, then derives enemy hits and death in closed form.
 */
export function sampleFight(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  distribution: Float64Array,
): FightOutcome {
  const u = rng.next();
  let acc = 0;
  let killAttack = 0;
  for (let n = 1; n < distribution.length; n++) {
    acc += distribution[n] ?? 0;
    if (u < acc) {
      killAttack = n;
      break;
    }
  }
  const deathHit = hitsToDie(health, setup.enemyHit);
  if (killAttack > 0) {
    const killOffset = killAttack * setup.playerIntervalMs;
    // Enemy hits strictly before the kill (the character acts first on ties).
    const enemyHits = Math.ceil(killOffset / setup.enemyIntervalMs) - 1;
    if (deathHit <= enemyHits) {
      return { kind: 'death', offsetMs: deathHit * setup.enemyIntervalMs, enemyHits: deathHit };
    }
    return { kind: 'kill', offsetMs: killOffset, enemyHits };
  }
  const enemyHits = Math.floor(setup.maxFightMs / setup.enemyIntervalMs);
  if (deathHit <= enemyHits) {
    return { kind: 'death', offsetMs: deathHit * setup.enemyIntervalMs, enemyHits: deathHit };
  }
  return { kind: 'timeout', offsetMs: setup.maxFightMs, enemyHits };
}
