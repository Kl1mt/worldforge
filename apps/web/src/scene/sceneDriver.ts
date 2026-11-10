import type { SceneBeat, SceneCue, SceneLoop } from './sceneLoop';

/**
 * Ticket A.14: drives a `SceneLoop` with ONE timer and turns its beats into CSS classes on the
 * scene's actor layers (`scene-anim.css` does the motion with transforms, opacity and a brief
 * filter flash). No React state changes per beat and no requests: only `classList` calls.
 *
 * Ticket A.14b: each concern has its own layer element, nested inside the CSS-only breath:
 *   fade (fall / rise, opacity) > act (own attack: strike / lunge) > hit (being struck: hit,
 *   hurt, glow) > sprite.
 * A layer carries **at most one** beat class at a time: playing a beat removes the layer's other
 * beat classes first. Before A.14b finished beats kept their classes, several classes fought over
 * one element's `animation`, and the stylesheet's order (not the newest beat) decided which one
 * ran; after a foe's first respawn its hits, lunges and the hero's strikes silently stopped.
 *
 * Everything the browser provides is injected (clock, timer, the elements), so tests run it in
 * node with a fake clock.
 */

/** The part of an element the driver touches. */
export interface ActorElement {
  classList: Pick<DOMTokenList, 'add' | 'remove' | 'contains'>;
  /** Reading it forces a style flush, which restarts a CSS animation when its class comes back. */
  readonly offsetWidth?: number;
}

/** One sprite's beat layers (any may be missing, e.g. while React re-mounts). */
export interface ActorLayers {
  fade: ActorElement | null;
  act: ActorElement | null;
  hit: ActorElement | null;
}

export interface SceneActors {
  hero: ActorLayers | null;
  foes: readonly (ActorLayers | null)[];
}

export interface DriverClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type LayerName = keyof ActorLayers;

/** The beat classes of each layer. A layer never carries two of them at once. */
export const LAYER_CLASSES = {
  fade: ['scene-anim--down', 'scene-anim--rise'],
  act: ['scene-anim--strike', 'scene-anim--lunge'],
  hit: ['scene-anim--hit', 'scene-anim--heavy', 'scene-anim--hurt', 'scene-anim--glow'],
} as const satisfies Record<LayerName, readonly string[]>;

/** Which layer and class each beat plays (`null` for an actor-less beat). */
export const BEAT_CLASS = {
  heroStrike: { layer: 'act', cls: 'scene-anim--strike' },
  foeStrike: { layer: 'act', cls: 'scene-anim--lunge' },
  foeHit: { layer: 'hit', cls: 'scene-anim--hit' },
  heroHit: { layer: 'hit', cls: 'scene-anim--hurt' },
  heroGlow: { layer: 'hit', cls: 'scene-anim--glow' },
  foeFall: { layer: 'fade', cls: 'scene-anim--down' },
  foeRise: { layer: 'fade', cls: 'scene-anim--rise' },
} as const satisfies Record<SceneBeat['kind'], { layer: LayerName; cls: string }>;

export const HEAVY_CLASS = 'scene-anim--heavy';
export const DOWN_CLASS = BEAT_CLASS.foeFall.cls;

/**
 * A one-shot beat this late is dropped instead of played (falls and rises are always applied):
 * a throttled or busy tab would otherwise fire several beats in one tick and stack them.
 */
export const LATE_BEAT_MS = 250;

/** Removes every beat class of a layer. */
function clear(el: ActorElement | null | undefined, layer: LayerName) {
  if (!el) return;
  for (const cls of LAYER_CLASSES[layer]) el.classList.remove(cls);
}

/** Plays `cls` on a layer from its start: the layer's other classes go, then `cls` (re)starts. */
function play(el: ActorElement | null | undefined, layer: LayerName, cls: string, extra?: string) {
  if (!el) return;
  const again = el.classList.contains(cls);
  clear(el, layer);
  if (again) void el.offsetWidth; // flush so the same animation starts over
  el.classList.add(cls);
  if (extra) el.classList.add(extra);
}

/** The actor a beat plays on: `hero*` beats on the hero (a strike names its target foe, but the
 * hero is the one who moves), `foe*` beats on that foe. */
function actorOf(beat: SceneBeat, actors: SceneActors): ActorLayers | null | undefined {
  switch (beat.kind) {
    case 'heroStrike':
    case 'heroHit':
    case 'heroGlow':
      return actors.hero;
    default:
      return actors.foes[beat.foe];
  }
}

/** Applies one beat to the actors. Exported for tests. */
export function applyBeat(beat: SceneBeat, actors: SceneActors) {
  const actor = actorOf(beat, actors);
  if (!actor) return;
  const { layer, cls } = BEAT_CLASS[beat.kind];
  switch (beat.kind) {
    case 'foeHit':
      play(actor.hit, 'hit', cls, beat.heavy ? HEAVY_CLASS : undefined);
      return;
    case 'foeFall':
      // The foe is gone: its attack and its last blow end with it.
      clear(actor.act, 'act');
      clear(actor.hit, 'hit');
      play(actor.fade, 'fade', cls);
      return;
    case 'foeRise':
      // A fresh foe: nothing of the last one carries over.
      clear(actor.act, 'act');
      clear(actor.hit, 'hit');
      play(actor.fade, 'fade', cls);
      return;
    default:
      play(actor[layer], layer, cls);
  }
}

/** True for beats that change who is standing (always applied, even late). */
/** Strips every class the driver may have set (on stop, so a resting scene is clean). */
export function resetActors(actors: SceneActors) {
  for (const actor of [actors.hero, ...actors.foes]) {
    if (!actor) continue;
    for (const layer of Object.keys(LAYER_CLASSES) as LayerName[]) clear(actor[layer], layer);
  }
}

/** A.14c: one foe's current life, as the player saw it. */
interface FoeLife {
  /** Faded out (its fall played) and not yet back. */
  down: boolean;
  /** A blow landed visibly since it last rose. */
  hit: boolean;
}

export interface SceneDriver {
  cue(cue: SceneCue): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

/**
 * Starts the loop. `actors()` is read at every beat, so React can swap elements (a new area)
 * without restarting the driver.
 */
export function startSceneDriver(options: {
  loop: SceneLoop;
  actors: () => SceneActors;
  clock: DriverClock;
}): SceneDriver {
  const { loop, actors, clock } = options;
  const origin = clock.now();
  let handle: unknown = null;
  let running = true;
  let paused = false;

  const elapsed = () => clock.now() - origin;

  const schedule = () => {
    if (!running || paused) return;
    const next = loop.nextAt();
    if (!Number.isFinite(next)) return; // an empty room: nothing to wait for
    handle = clock.setTimer(tick, Math.max(0, next - elapsed()));
  };

  /**
   * A.14c: what each foe showed in its current life. The owner's rule: **a foe never fades out
   * unless it took at least one visible hit in this life.** A hitch could drop a blow as late
   * (it is due 200 ms before the fall) while the fall itself was on time, so a foe faded with no
   * blow before it. Now such a fall is dropped, and with it the rise that would follow (the foe
   * simply stays standing); and a rise only plays on a foe that is actually down.
   */
  const lives: FoeLife[] = [];
  const lifeOf = (foe: number) => (lives[foe] ??= { down: false, hit: false });

  /** Applies what is due; one-shot beats later than LATE_BEAT_MS (or all, when `skip`) drop. */
  const flush = (skip: boolean) => {
    const now = elapsed();
    const current = actors();
    for (const { at, beat } of loop.advance(now)) {
      const onTime = !skip && now - at <= LATE_BEAT_MS;
      if (beat.kind === 'foeFall') {
        const life = lifeOf(beat.foe);
        if (life.down || !life.hit) continue; // no visible blow in this life: no fade
        life.down = true;
        applyBeat(beat, current);
      } else if (beat.kind === 'foeRise') {
        const life = lifeOf(beat.foe);
        if (!life.down) continue; // its fall was dropped: the foe never left
        life.down = false;
        life.hit = false;
        applyBeat(beat, current);
      } else if (onTime) {
        if (beat.kind === 'foeHit') {
          // Only a blow that can be seen counts (a foe without its element shows nothing).
          if (current.foes[beat.foe]?.hit) lifeOf(beat.foe).hit = true;
        }
        applyBeat(beat, current);
      }
    }
  };

  function tick() {
    handle = null;
    if (!running || paused) return;
    flush(false);
    schedule();
  }

  const cancel = () => {
    if (handle !== null) clock.clearTimer(handle);
    handle = null;
  };

  schedule();

  return {
    cue(cue) {
      if (!running) return;
      loop.cue(cue, elapsed());
      cancel();
      schedule();
    },
    pause() {
      paused = true;
      cancel();
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      // Skip what was due while hidden, but bring back any foe that should have risen meanwhile.
      flush(true);
      schedule();
    },
    stop() {
      running = false;
      cancel();
      lives.length = 0;
      resetActors(actors());
    },
  };
}
