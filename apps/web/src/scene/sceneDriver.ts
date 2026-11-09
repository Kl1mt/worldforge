import type { SceneBeat, SceneCue, SceneLoop } from './sceneLoop';

/**
 * Ticket A.14: drives a `SceneLoop` with ONE timer and turns its beats into CSS classes on the
 * scene's actor wrappers (`scene-anim.css` does the motion with transforms, opacity and a brief
 * filter flash). No React state changes per beat and no requests: only `classList` calls.
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

export interface SceneActors {
  hero: ActorElement | null;
  foes: readonly (ActorElement | null)[];
}

export interface DriverClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Transient classes: each plays its animation once and is restarted by the next beat. */
export const BEAT_CLASS = {
  heroStrike: 'scene-anim--strike',
  foeHit: 'scene-anim--hit',
  foeHeavy: 'scene-anim--heavy',
  foeStrike: 'scene-anim--lunge',
  heroHit: 'scene-anim--hurt',
  foeRise: 'scene-anim--rise',
  heroGlow: 'scene-anim--glow',
} as const;
/** Persistent while a foe is down. */
export const DOWN_CLASS = 'scene-anim--down';

function restart(el: ActorElement | null | undefined, cls: string) {
  if (!el) return;
  if (el.classList.contains(cls)) {
    el.classList.remove(cls);
    void el.offsetWidth; // flush so the animation starts over
  }
  el.classList.add(cls);
}

/** Applies one beat to the actors. Exported for tests. */
export function applyBeat(beat: SceneBeat, actors: SceneActors) {
  switch (beat.kind) {
    case 'heroStrike':
      restart(actors.hero, BEAT_CLASS.heroStrike);
      return;
    case 'heroHit':
      restart(actors.hero, BEAT_CLASS.heroHit);
      return;
    case 'heroGlow':
      restart(actors.hero, BEAT_CLASS.heroGlow);
      return;
    case 'foeHit': {
      const foe = actors.foes[beat.foe];
      foe?.classList.remove(BEAT_CLASS.foeHeavy);
      if (beat.heavy) foe?.classList.add(BEAT_CLASS.foeHeavy);
      restart(foe, BEAT_CLASS.foeHit);
      return;
    }
    case 'foeStrike':
      restart(actors.foes[beat.foe], BEAT_CLASS.foeStrike);
      return;
    case 'foeFall': {
      const foe = actors.foes[beat.foe];
      foe?.classList.remove(BEAT_CLASS.foeRise);
      foe?.classList.add(DOWN_CLASS);
      return;
    }
    case 'foeRise': {
      const foe = actors.foes[beat.foe];
      foe?.classList.remove(DOWN_CLASS);
      restart(foe, BEAT_CLASS.foeRise);
      return;
    }
  }
}

/** Strips every class the driver may have set (on stop, so a resting scene is clean). */
export function resetActors(actors: SceneActors) {
  const all = [...Object.values(BEAT_CLASS), DOWN_CLASS];
  for (const el of [actors.hero, ...actors.foes]) {
    if (el) for (const cls of all) el.classList.remove(cls);
  }
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

  function tick() {
    handle = null;
    if (!running || paused) return;
    const current = actors();
    for (const { beat } of loop.advance(elapsed())) applyBeat(beat, current);
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
      const current = actors();
      for (const { beat } of loop.advance(elapsed())) {
        if (beat.kind === 'foeRise' || beat.kind === 'foeFall') applyBeat(beat, current);
      }
      schedule();
    },
    stop() {
      running = false;
      cancel();
      resetActors(actors());
    },
  };
}
