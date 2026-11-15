import {
  PULSE_MS,
  RESOURCE_RULES,
  getActiveSkill,
  getPassiveSkill,
  kitRules,
  type ClassId,
  type ResourceRules,
} from '@worldforge/game-core';
import type { SceneBeat } from './sceneLoop';

/**
 * Ticket 9.2: the combat scene's resource bar (Rage 62 / 100). Like the scene loop (A.14) it only
 * *suggests* the fight the server settles: it applies game-core's resource rules (`RESOURCE_RULES`
 * plus the passive's, `kitRules`) to the scene's own beats. A hero strike gains `perAttack`, a
 * blow taken `perBlowTaken`, every second the pulse (`perPulse`, `perUnhitPulse` while unhit,
 * `perDotPulse` while a damage over time runs); a spender of the loadout in force spends its cost
 * when it can. A fallen foe ends the fight: the resource resets (the warlock keeps the fragments a
 * kill leaves, `carryOnKill`). No DOM, no timers: the caller feeds beats with their times.
 */

export interface MotionLoadout {
  actives: readonly (string | null)[];
  passive?: string | null;
}

export interface ResourceSnapshot {
  value: number;
  max: number;
  /** A damage over time is ticking on the current foe. */
  ticking: boolean;
  /** Bumped on every tick, so the caller can replay the tick mark. */
  ticks: number;
}

interface Spender {
  cost: number;
  consumeAll: boolean;
  gain: number;
  dot: boolean;
}

export class ResourceMotion {
  private readonly rules: ResourceRules;
  private readonly start: number;
  private readonly spenders: Spender[];
  private readonly coreDot: boolean;
  private readonly coreEvery: number;
  private value: number;
  private lastPulse: number | null = null;
  private unhit = true;
  private dotLeft = 0;
  private readonly dotTicks: number;
  private strikes = 0;
  private ticks = 0;

  constructor(classId: ClassId, loadout: MotionLoadout | null, fragments = 0) {
    const passive = loadout?.passive ? getPassiveSkill(loadout.passive) : undefined;
    this.rules = kitRules(classId, passive?.modifiers ?? {});
    const base = RESOURCE_RULES[classId].start;
    const actives = (loadout?.actives ?? []).flatMap((id) => {
      const s = id ? getActiveSkill(id) : undefined;
      return s && s.classId === classId ? [s] : [];
    });
    const core = actives.find((s) => s.kind === 'core');
    this.coreDot = core?.dot !== undefined;
    this.coreEvery = core?.everyNthAttack ?? 4;
    this.spenders = actives
      .filter((s) => s.kind === 'spender')
      .map((s) => ({
        cost: s.cost ?? 0,
        consumeAll: s.consumeAll === true,
        gain: s.gain ?? 0,
        dot: s.dot !== undefined,
      }));
    this.dotTicks = Math.max(0, ...actives.map((s) => s.dot?.ticks ?? 0));
    this.start =
      this.rules.carryOnKill > 0
        ? Math.min(this.rules.max, Math.max(0, Math.floor(fragments)))
        : base === 'full'
          ? this.rules.max
          : Math.min(this.rules.max, base);
    this.value = this.start;
  }

  snapshot(): ResourceSnapshot {
    return { value: this.value, max: this.rules.max, ticking: this.dotLeft > 0, ticks: this.ticks };
  }

  private clamp(v: number) {
    return Math.min(this.rules.max, Math.max(0, v));
  }

  /** Pulses due since the last one (every `PULSE_MS` of scene time). */
  private pulses(at: number) {
    if (this.lastPulse === null) {
      this.lastPulse = at;
      return;
    }
    while (at - this.lastPulse >= PULSE_MS) {
      this.lastPulse += PULSE_MS;
      let r = this.value + this.rules.perPulse;
      if (this.unhit) r += this.rules.perUnhitPulse;
      if (this.dotLeft > 0) {
        this.dotLeft -= 1;
        this.ticks += 1;
        r += this.rules.perDotPulse;
      }
      this.unhit = true;
      this.value = this.clamp(r);
    }
  }

  /** Applies one scene beat at scene time `at` (ms); returns whether the bar moved. */
  beat(beat: SceneBeat, at: number): boolean {
    const before = `${this.value}|${this.dotLeft}|${this.ticks}`;
    this.pulses(at);
    switch (beat.kind) {
      case 'heroStrike': {
        this.strikes += 1;
        let r = this.value + this.rules.perAttack;
        if (this.strikes % this.coreEvery === 0) {
          if (this.coreDot) this.dotLeft = this.dotTicks;
        } else {
          const sp = this.spenders.find(
            (s) =>
              this.value >= Math.max(s.cost, s.consumeAll ? 1 : 0) && !(s.dot && this.dotLeft > 0),
          );
          if (sp) {
            r = (sp.consumeAll ? 0 : r - sp.cost) + sp.gain;
            if (sp.dot) this.dotLeft = this.dotTicks;
          }
        }
        this.value = this.clamp(r);
        break;
      }
      case 'heroHit':
        this.unhit = false;
        this.value = this.clamp(this.value + this.rules.perBlowTaken);
        break;
      case 'foeFall':
        // The fight is over: the search between fights resets the resource.
        // The warlock keeps what a kill leaves, if the loadout uses fragments at all.
        this.value =
          this.rules.carryOnKill > 0 && (this.spenders.length > 0 || this.coreDot)
            ? Math.min(this.rules.max, this.rules.carryOnKill)
            : this.start;
        this.dotLeft = 0;
        this.strikes = 0;
        this.unhit = true;
        break;
      default:
        break;
    }
    return before !== `${this.value}|${this.dotLeft}|${this.ticks}`;
  }
}

/** What the bar is called: Rage, Mana, Focus, Soul Fragments. */
export const RESOURCE_LABEL: Record<ClassId, string> = {
  warrior: 'Rage',
  mage: 'Mana',
  hunter: 'Focus',
  warlock: 'Soul Fragments',
};
