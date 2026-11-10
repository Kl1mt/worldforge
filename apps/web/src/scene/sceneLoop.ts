/**
 * Ticket A.14: the fight scene's cosmetic loop.
 *
 * Combat is settled on the server; the scene only *suggests* a fight. This module decides what
 * happens next (who strikes, who flinches, who falls) as a plain schedule of beats, with no DOM,
 * no timers and no randomness of its own: the caller passes a random source and drives it with
 * its own clock, so tests step it with an injected clock. Nothing here affects gameplay or sends
 * a request.
 */

/** One visual event. `foe` is an index into the scene's line of foes. */
export type SceneBeat =
  | { kind: 'heroStrike'; foe: number }
  | { kind: 'foeHit'; foe: number; heavy: boolean }
  | { kind: 'foeStrike'; foe: number }
  | { kind: 'heroHit' }
  | { kind: 'foeFall'; foe: number }
  | { kind: 'foeRise'; foe: number }
  | { kind: 'heroGlow' };

/** Something the chronicle reported since the last settle (flavour only, never exact). */
export type SceneCue = 'kill' | 'level' | 'death';

export interface ScenePlan {
  /** Time from one hero swing to the next. */
  cadenceMs: number;
  /** From the swing to the blow landing (the lunge's furthest point). */
  impactMs: number;
  /** A.14b: per foe, from its lunge (or its frames) to its blow landing on the hero. */
  foeImpactMs: readonly number[];
  /** A fallen foe stays down this long before a new one fades in. */
  respawnMs: number;
  /** Number of foes in the line (0 = an empty room: the hero only breathes). */
  foes: number;
}

/** A code lunge reaches the foe at 40 % of its 450 ms (scene-anim.css `scene-anim-lunge`). */
export const LUNGE_IMPACT_MS = 180;
/** A frame sheet plays 8 frames at 80 ms; the blow lands on frame 5 or 6. */
export const SHEET_FRAME_MS = 80;
export const FRAMED_IMPACT_MS = SHEET_FRAME_MS * 5 + 20;

/** Bounds of the swing cadence: calm enough to read, never frantic. */
export const CADENCE_MIN_MS = 1_200;
export const CADENCE_MAX_MS = 2_600;
/** One real attack per second reads as busy at idle-game pace; the scene swings at 1/1.6 of it. */
const CADENCE_SLOWDOWN = 1.6;

/**
 * The loop's rhythm from the hero's attack speed (attacks per second, game-core `StatBlock`):
 * a faster hero swings more often, within [CADENCE_MIN_MS, CADENCE_MAX_MS]. Unknown or broken
 * stats fall back to one swing every 1.6 s.
 */
export function planFor(input: {
  attackSpeed?: number | null | undefined;
  foes: number;
  /** The hero swings with a frame sheet: the blow lands at the slash, later than a lunge's. */
  framed?: boolean;
  /** A.14b: which foes strike with a frame sheet (their blow lands later too). */
  framedFoes?: readonly boolean[];
}): ScenePlan {
  const speed = input.attackSpeed;
  const raw =
    speed && Number.isFinite(speed) && speed > 0 ? (1000 * CADENCE_SLOWDOWN) / speed : 1600;
  const cadenceMs = Math.round(Math.min(CADENCE_MAX_MS, Math.max(CADENCE_MIN_MS, raw)));
  return {
    cadenceMs,
    impactMs: input.framed ? FRAMED_IMPACT_MS : LUNGE_IMPACT_MS,
    foeImpactMs: Array.from({ length: Math.max(0, Math.floor(input.foes)) }, (_, i) =>
      input.framedFoes?.[i] ? FRAMED_IMPACT_MS : LUNGE_IMPACT_MS,
    ),
    respawnMs: Math.max(1_600, cadenceMs * 1.25),
    foes: Math.max(0, Math.floor(input.foes)),
  };
}

export interface ScheduledBeat {
  /** Milliseconds since the loop started. */
  at: number;
  beat: SceneBeat;
}

/** A source of numbers in [0, 1). Production passes `Math.random`; tests pass a seeded one. */
export type Random = () => number;

/**
 * The loop's state machine. `advance(now)` returns every beat due up to `now` (ms since start)
 * and `nextAt()` says when to call it again, so the caller needs exactly one timer.
 */
export class SceneLoop {
  private readonly plan: ScenePlan;
  private readonly random: Random;
  private queue: ScheduledBeat[] = [];
  private nextSwing: number;
  private target = 0;
  private hitsLeft: number;
  private swingsSinceRiposte = 0;
  /** Foes currently down (index → time they rise). */
  private readonly down = new Map<number, number>();
  /** The chronicle reported a kill: the next blow fells the target. */
  private pendingKill = false;

  constructor(plan: ScenePlan, random: Random, startAt = 0) {
    this.plan = plan;
    this.random = random;
    // A short first beat so the scene comes alive soon after the screen opens.
    this.nextSwing = startAt + Math.round(plan.cadenceMs * 0.5);
    this.hitsLeft = this.rollHits();
  }

  /** Flavour from the chronicle. Never changes what the server settled. */
  cue(cue: SceneCue, now: number) {
    if (cue === 'kill') this.pendingKill = true;
    else if (cue === 'level') this.push(now, { kind: 'heroGlow' });
    else if (cue === 'death') this.push(now, { kind: 'heroHit' });
  }

  /** When the next beat is due (ms since start); `Infinity` in an empty room (nothing to fight). */
  nextAt(): number {
    if (this.plan.foes === 0) return this.queue[0]?.at ?? Infinity;
    this.fill();
    return this.queue[0]!.at;
  }

  /** Every beat due at or before `now`, in time order, with the time it was scheduled for. */
  advance(now: number): ScheduledBeat[] {
    this.fill(now);
    const due: ScheduledBeat[] = [];
    while (this.queue.length > 0 && this.queue[0]!.at <= now) due.push(this.queue.shift()!);
    return due;
  }

  /** Keep the queue at least one swing ahead of `now`. */
  private fill(now = -Infinity) {
    if (this.plan.foes === 0) return; // an empty room: only cues (a level-up glow) play
    while (this.queue.length === 0 || this.nextSwing <= now) {
      this.swing(this.nextSwing);
      // ±10 % jitter so the rhythm breathes, in whole milliseconds.
      const jitter = 1 + (this.random() - 0.5) * 0.2;
      this.nextSwing += Math.round(this.plan.cadenceMs * jitter);
    }
  }

  private rollHits() {
    return 2 + Math.floor(this.random() * 3); // 2–4 blows per foe
  }

  private push(at: number, beat: SceneBeat) {
    const entry = { at: Math.round(at), beat };
    // Insert in time order (stable for equal times); the queue is a handful of entries.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.at > entry.at) i--;
    this.queue.splice(i, 0, entry);
  }

  private standing(at: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.plan.foes; i++) {
      const rise = this.down.get(i);
      if (rise === undefined || rise <= at) {
        this.down.delete(i);
        out.push(i);
      }
    }
    return out;
  }

  private swing(at: number) {
    const standing = this.standing(at);
    if (standing.length === 0) return; // everyone is down; wait for the next rise
    if (!standing.includes(this.target)) {
      this.target = standing[Math.floor(this.random() * standing.length)]!;
      this.hitsLeft = this.rollHits();
    }
    const foe = this.target;
    const impact = at + this.plan.impactMs;
    this.push(at, { kind: 'heroStrike', foe });
    this.hitsLeft -= 1;
    const fells = this.hitsLeft <= 0 || this.pendingKill;
    this.push(impact, { kind: 'foeHit', foe, heavy: fells || this.random() < 0.15 });

    if (fells) {
      this.pendingKill = false;
      const fallAt = impact + 200;
      const riseAt = fallAt + this.plan.respawnMs;
      this.push(fallAt, { kind: 'foeFall', foe });
      this.push(riseAt, { kind: 'foeRise', foe });
      this.down.set(foe, riseAt);
      return;
    }

    // Now and then a foe answers: it lunges halfway between two swings and the hero flinches.
    this.swingsSinceRiposte += 1;
    if (this.swingsSinceRiposte >= 2 && this.random() < 0.45) {
      this.swingsSinceRiposte = 0;
      const attackers = standing;
      const attacker = attackers[Math.floor(this.random() * attackers.length)]!;
      const strikeAt = at + Math.round(this.plan.cadenceMs * 0.5);
      this.push(strikeAt, { kind: 'foeStrike', foe: attacker });
      const landsAfter = this.plan.foeImpactMs[attacker] ?? LUNGE_IMPACT_MS;
      this.push(strikeAt + landsAfter, { kind: 'heroHit' });
    }
  }
}

/** A small seeded random source (mulberry32) for tests and screenshots. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cues from the chronicle (newest first) since the entry `seenId`: kills, level-ups, deaths. When
 * `seenId` is null (the screen just opened) nothing is replayed: the scene starts fresh.
 */
export function cuesSince(
  chronicle: readonly { id: string; kind: string }[],
  seenId: string | null,
): SceneCue[] {
  if (seenId === null) return [];
  const out: SceneCue[] = [];
  for (const entry of chronicle) {
    if (entry.id === seenId) break;
    if (entry.kind === 'kill' || entry.kind === 'level' || entry.kind === 'death') {
      out.push(entry.kind);
    }
  }
  return out.reverse();
}
