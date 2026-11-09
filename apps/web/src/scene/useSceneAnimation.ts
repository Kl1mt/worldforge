import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMediaQuery } from '../components/useMediaQuery';
import {
  browserMotionFlags,
  REDUCED_MOTION_QUERY,
  sceneMotionMode,
  type SceneMotion,
} from './motion';
import { startSceneDriver, type SceneDriver } from './sceneDriver';
import { cuesSince, planFor, SceneLoop } from './sceneLoop';

/** Ticket A.14: `full`, `reduced` or `off` for this browser (see `motion.ts`). */
export function useSceneMotion(): SceneMotion {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const flags = useMemo(() => browserMotionFlags(), []);
  return sceneMotionMode({ reducedMotion, ...flags });
}

const browserClock = {
  now: () => performance.now(),
  setTimer: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimer: (handle: unknown) => window.clearTimeout(handle as number),
};

/**
 * Runs the scene's cosmetic fight loop while `active` (farming, or a crypt fight in progress) and
 * motion is `full`. Returns ref callbacks for the hero's and each foe's actor wrapper. One timer;
 * it stops while the tab is hidden; nothing here re-renders React or sends a request.
 */
export function useSceneAnimation(options: {
  active: boolean;
  motion: SceneMotion;
  foes: number;
  attackSpeed?: number | null;
  framed?: boolean;
  /** The chronicle (newest first): kills, level-ups and deaths flavour the loop. */
  chronicle?: readonly { id: string; kind: string }[];
}) {
  const { active, motion, foes, attackSpeed, framed, chronicle } = options;
  const hero = useRef<HTMLElement | null>(null);
  const foeEls = useRef<(HTMLElement | null)[]>([]);
  const driver = useRef<SceneDriver | null>(null);
  const seen = useRef<string | null>(null);

  const heroRef = useCallback((el: HTMLElement | null) => {
    hero.current = el;
  }, []);
  // One stable callback per index, so React doesn't detach and re-attach refs on every render.
  const foeCallbacks = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const foeRef = useCallback((index: number) => {
    let cb = foeCallbacks.current.get(index);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        foeEls.current[index] = el;
      };
      foeCallbacks.current.set(index, cb);
    }
    return cb;
  }, []);

  const running = active && motion === 'full' && foes > 0;
  // Speed is rounded so a small stat change doesn't restart the loop mid-swing.
  const speed = attackSpeed ? Math.round(attackSpeed * 20) / 20 : null;

  useEffect(() => {
    if (!running) return;
    const loop = new SceneLoop(
      planFor({ attackSpeed: speed, foes, framed: framed === true }),
      Math.random,
    );
    const d = startSceneDriver({
      loop,
      clock: browserClock,
      actors: () => ({ hero: hero.current, foes: foeEls.current.slice(0, foes) }),
    });
    driver.current = d;
    const onVisibility = () => (document.hidden ? d.pause() : d.resume());
    if (document.hidden) d.pause();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      d.stop();
      driver.current = null;
    };
  }, [running, speed, foes, framed]);

  const head = chronicle?.[0]?.id ?? null;
  useEffect(() => {
    if (!chronicle) return;
    const cues = cuesSince(chronicle, seen.current);
    seen.current = head;
    for (const cue of cues) driver.current?.cue(cue);
    // Only a new head matters; the chronicle array itself is rebuilt on every settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head]);

  return { heroRef, foeRef };
}
