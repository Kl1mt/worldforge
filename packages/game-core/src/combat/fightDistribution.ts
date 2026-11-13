import type { Rng } from '../rng.js';
import type { EncounterSetup, FightOutcome } from './encounter.js';
import { attackHit, dependsOnHeroHealth, hitsToDie, kitAttack, thornsDamage } from './encounter.js';
import {
  kitAfterAttack,
  kitBlow,
  kitPulse,
  kitStart,
  kitStateKey,
  pulseAt,
  shadowCompare,
  skillsPrototypeMode,
  withoutKit,
  type KitState,
} from './kit.js';

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
  if (setup.kit) {
    const kit = killDistributionKit(setup, health);
    if (setup.kit.isDefault && skillsPrototypeMode() === 'shadow') {
      const today = withoutKit(setup);
      shadowCompare('killDistribution', killDistributionToday(today, health), kit);
    }
    return kit;
  }
  return killDistributionToday(setup, health);
}

function killDistributionToday(setup: EncounterSetup, health: number): KillEvent[] {
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
          // Ticket B.2: a surged attack's crit does not surge the next one.
          [hit.crit, hit.critChance, tracksCrit && !hit.surged ? 1 : 0],
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

interface KitDpState {
  p: number;
  dealt: number;
  flag: number;
  kit: KitState;
}

/**
 * Ticket 9.1: the exact distribution under a kit — the state-machine dynamic program. The state
 * adds the kit's state (resource, cooldowns, damage-over-time ticks left, "unhit") to the damage
 * dealt and the previous-crit flag; every transition is deterministic except the crit roll, so
 * equal states still merge. The timeline merges hero attacks, the fight's pulses (damage over time,
 * timed resources) and enemy blows (thorns, Rage, Focus), in that order on equal times. The hero's
 * health stays closed-form: no skill heals or shields (docs/SKILLS.md), so death is still decided
 * by `sampleFight`. With an inactive kit (the default loadout) the steps, merges and sums are
 * exactly `killDistribution`'s, so the result is bit-identical (asserted by the shadow replay).
 */
function killDistributionKit(setup: EncounterSetup, health: number): KillEvent[] {
  const kit = setup.kit!;
  const events: KillEvent[] = [];
  const thorns = thornsDamage(setup);
  const tracksCrit = (setup.effects?.skillSurge ?? 0) > 0;
  const blows = thorns > 0 || kit.listensToBlows;
  const pulses = kit.pulses;
  const start = kitStart(kit);
  const keyOf = (dealt: number, flag: number, st: KitState) =>
    kit.active ? `${dealt * 2 + flag}|${kitStateKey(st)}` : `${dealt * 2 + flag}`;
  let states = new Map<string, KitDpState>([
    [keyOf(0, 0, start), { p: 1, dealt: 0, flag: 0, kit: start }],
  ]);
  const add = (
    next: Map<string, KitDpState>,
    dealt: number,
    flag: number,
    st: KitState,
    pq: number,
  ) => {
    const k = keyOf(dealt, flag, st);
    const prev = next.get(k);
    if (prev) prev.p += pq;
    else next.set(k, { p: pq, dealt, flag, kit: st });
  };
  let attack = 1;
  let enemyAttack = 1;
  let pulse = 1;
  while (states.size > 0) {
    const p = attack * setup.playerIntervalMs;
    const e = blows ? enemyAttack * setup.enemyIntervalMs : Infinity;
    const q = pulses ? pulseAt(pulse) : Infinity;
    if (p <= setup.maxFightMs && p <= e && p <= q) {
      const hitsBefore = Math.ceil(p / setup.enemyIntervalMs) - 1;
      const heroHealth = Math.max(0, health - hitsBefore * setup.enemyHit);
      const event: KillEvent = { offsetMs: p, enemyHits: hitsBefore, probability: 0, attack };
      const next = new Map<string, KitDpState>();
      for (const s of states.values()) {
        const remaining = setup.enemyHealth - s.dealt;
        const { hit, action } = kitAttack(
          setup,
          s.kit,
          attack,
          p,
          s.flag === 1,
          heroHealth,
          remaining,
        );
        const outcomes: [number, number, number, boolean][] = [
          [hit.normal, 1 - hit.critChance, 0, false],
          [hit.crit, hit.critChance, tracksCrit && !hit.surged ? 1 : 0, true],
        ];
        for (const [damage, q0, flag, crit] of outcomes) {
          if (q0 <= 0) continue;
          const total = s.dealt + damage;
          const pq = s.p * q0;
          if (total >= setup.enemyHealth) {
            event.probability += pq;
          } else {
            const st = kit.active ? kitAfterAttack(kit, s.kit, action, crit, p) : s.kit;
            add(next, total, flag, st, pq);
          }
        }
      }
      events.push(event);
      states = next;
      attack++;
    } else if (q <= setup.maxFightMs && q <= e) {
      const hitsBefore = Math.ceil(q / setup.enemyIntervalMs) - 1;
      const event: KillEvent = { offsetMs: q, enemyHits: hitsBefore, probability: 0, attack: 0 };
      const next = new Map<string, KitDpState>();
      for (const s of states.values()) {
        const { damage, state } = kitPulse(kit, s.kit);
        const total = s.dealt + damage;
        if (total >= setup.enemyHealth) event.probability += s.p;
        else add(next, total, s.flag, state, s.p);
      }
      if (event.probability > 0) events.push(event);
      states = next;
      pulse++;
    } else if (blows && e <= setup.maxFightMs) {
      const event: KillEvent = { offsetMs: e, enemyHits: enemyAttack, probability: 0, attack: 0 };
      const next = new Map<string, KitDpState>();
      for (const s of states.values()) {
        const total = s.dealt + thorns;
        if (total >= setup.enemyHealth) event.probability += s.p;
        else add(next, total, s.flag, kit.active ? kitBlow(kit, s.kit) : s.kit, s.p);
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
  // Ticket 9.1: an active kit depends on its loadout, its start and the enemy's rhythm too.
  const kit = s.kit?.active
    ? `|kit:${s.kit.key}|${s.kit.start}|${s.kit.dealt}|${s.kit.critDamage}|${s.kit.critChance}|${s.enemyIntervalMs}|${s.enemyHit}`
    : '';
  if (!s.effects) return key + kit;
  const hp = dependsOnHeroHealth(s) ? `|hp:${health}` : '';
  return `${key}|${s.enemyIntervalMs}|${s.enemyHit}|${JSON.stringify(s.effects)}${hp}${kit}`;
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
