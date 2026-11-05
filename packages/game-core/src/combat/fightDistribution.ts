import type { Rng } from '../rng.js';
import type { EncounterSetup, FightOutcome } from './encounter.js';
import { attackHit, dependsOnHeroHealth, hitsToDie, thornsDamage } from './encounter.js';

/** One way the enemy can die: when, after how many enemy hits, and how likely. */
export interface KillEvent {
  offsetMs: number;
  /** Enemy hits landed before the kill (a thorns kill counts the hit that triggered it). */
  enemyHits: number;
  probability: number;
  /** The hero attack that kills (1-based), or 0 for a thorns kill. */
  attack: number;
}

/**
 * Exact probability distribution of how the enemy dies within `maxFightMs`, in time order. The
 * remaining mass is the probability of not killing it in time.
 *
 * Dynamic programming over the damage dealt so far (plus, with Mana Surge, whether the previous
 * attack crit): each attack's damage is one of two integers, so equal states merge and the state
 * space stays small. Effects (ticket 3.2) price every attack through `attackHit` — the same
 * function the detailed simulation uses — with the enemy's remaining health known from the state
 * and the hero's health known in closed form (enemy hits are fixed until the hero dies; what
 * happens after that never matters). Thorns add deterministic damage at every enemy hit.
 *
 * `health` is the hero's health at the fight start; it only matters for health-dependent effects.
 */
export function killDistribution(setup: EncounterSetup, health: number): KillEvent[] {
  const events: KillEvent[] = [];
  const thorns = thornsDamage(setup);
  const tracksCrit = (setup.effects?.skillSurge ?? 0) > 0;
  // State key: dealt · 2 + (previous attack crit ? 1 : 0).
  let states = new Map<number, number>([[0, 1]]);
  let attack = 1;
  let enemyAttack = 1;
  while (states.size > 0) {
    const p = attack * setup.playerIntervalMs;
    const e = enemyAttack * setup.enemyIntervalMs;
    if (p <= setup.maxFightMs && (thorns === 0 || p <= e)) {
      // Enemy hits strictly before this attack (the hero acts first on ties).
      const hitsBefore = Math.ceil(p / setup.enemyIntervalMs) - 1;
      const heroHealth = Math.max(0, health - hitsBefore * setup.enemyHit);
      const event: KillEvent = { offsetMs: p, enemyHits: hitsBefore, probability: 0, attack };
      const next = new Map<number, number>();
      for (const [key, p0] of states) {
        const dealt = Math.floor(key / 2);
        const hit = attackHit(setup, attack, key % 2 === 1, heroHealth, setup.enemyHealth - dealt);
        const outcomes: [number, number, number][] = [
          [hit.normal, 1 - hit.critChance, 0],
          [hit.crit, hit.critChance, tracksCrit ? 1 : 0],
        ];
        for (const [damage, q, flag] of outcomes) {
          if (q <= 0) continue;
          const total = dealt + damage;
          const pq = p0 * q;
          if (total >= setup.enemyHealth) {
            event.probability += pq;
          } else {
            const k = total * 2 + flag;
            next.set(k, (next.get(k) ?? 0) + pq);
          }
        }
      }
      events.push(event);
      states = next;
      attack++;
    } else if (thorns > 0 && e <= setup.maxFightMs) {
      const event: KillEvent = { offsetMs: e, enemyHits: enemyAttack, probability: 0, attack: 0 };
      const next = new Map<number, number>();
      for (const [key, p0] of states) {
        const total = Math.floor(key / 2) + thorns;
        if (total >= setup.enemyHealth) {
          event.probability += p0;
        } else {
          const k = total * 2 + (key % 2);
          next.set(k, (next.get(k) ?? 0) + p0);
        }
      }
      if (event.probability > 0) events.push(event);
      states = next;
      enemyAttack++;
    } else {
      break;
    }
  }
  return events;
}

/**
 * P(kill on attack n) for n = 1…floor(maxFightMs / playerIntervalMs); index 0 is unused. Only
 * hero-attack kills (thorns kills are left out); kept for tests and tooling.
 */
export function hitsToKillDistribution(setup: EncounterSetup, health?: number): Float64Array {
  const maxAttacks = Math.floor(setup.maxFightMs / setup.playerIntervalMs);
  const probabilities = new Float64Array(maxAttacks + 1);
  const start = health ?? setup.effects?.maxHealth ?? Number.MAX_SAFE_INTEGER;
  for (const e of killDistribution(setup, start)) {
    if (e.attack > 0) probabilities[e.attack] = e.probability;
  }
  return probabilities;
}

/**
 * Cache key of everything `killDistribution` depends on: the setup, and the start health when a
 * health-dependent effect is active.
 */
export function distributionKey(s: EncounterSetup, health?: number): string {
  const key = [
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
  if (!s.effects) return key;
  const hp = dependsOnHeroHealth(s) ? `|hp:${health}` : '';
  return `${key}|${s.enemyIntervalMs}|${s.enemyHit}|${JSON.stringify(s.effects)}${hp}`;
}

/**
 * Resolves a fight with a single RNG draw: samples how the enemy dies from the exact
 * distribution, then derives enemy hits and death in closed form.
 */
export function sampleFight(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  distribution: readonly KillEvent[],
): FightOutcome {
  const u = rng.next();
  let acc = 0;
  let kill: KillEvent | undefined;
  for (const event of distribution) {
    acc += event.probability;
    if (u < acc) {
      kill = event;
      break;
    }
  }
  const deathHit = hitsToDie(health, setup.enemyHit);
  if (kill) {
    if (deathHit <= kill.enemyHits) {
      return { kind: 'death', offsetMs: deathHit * setup.enemyIntervalMs, enemyHits: deathHit };
    }
    return { kind: 'kill', offsetMs: kill.offsetMs, enemyHits: kill.enemyHits };
  }
  const enemyHits = Math.floor(setup.maxFightMs / setup.enemyIntervalMs);
  if (deathHit <= enemyHits) {
    return { kind: 'death', offsetMs: deathHit * setup.enemyIntervalMs, enemyHits: deathHit };
  }
  return { kind: 'timeout', offsetMs: setup.maxFightMs, enemyHits };
}
