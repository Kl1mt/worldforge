import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClassId } from '@worldforge/game-core';
import { apiRequest } from '../lib/api';
import { RESOURCE_LABEL, ResourceMotion, type MotionLoadout } from './resourceMotion';
import type { SceneBeat } from './sceneLoop';

/** Ticket 9.2: the part of `GET /characters/:id/skills` the scene reads. */
interface LoadoutInForce {
  inForce: MotionLoadout;
  soulFragments: number;
}

/**
 * The loadout the hero fights with now (for the scene's resource bar). A failed read falls back to
 * the default loadout: the bar is flavour, the Skills screen shows the real state and its errors.
 */
export function useLoadoutInForce(characterId: string): LoadoutInForce | null {
  const [state, setState] = useState<LoadoutInForce | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void apiRequest<LoadoutInForce>(`/characters/${characterId}/skills`, {
      signal: abort.signal,
    }).then((r) => {
      if (abort.signal.aborted) return;
      setState(r.ok ? r.value : { inForce: { actives: [], passive: null }, soulFragments: 0 });
    });
    return () => abort.abort();
  }, [characterId]);
  return state;
}

const variantOf: Record<ClassId, string> = {
  warrior: 'rage',
  mage: 'mana',
  hunter: 'focus',
  warlock: 'soul',
};

/**
 * The resource bar in the scene's HUD ("Rage 62 / 100"). It follows the scene's beats through a
 * `ResourceMotion` and writes the DOM directly (no React render per beat, like the scene driver).
 * Returns the element and the beat listener to pass to `useSceneAnimation`.
 */
export function useResourceGauge(
  classId: ClassId,
  loadout: LoadoutInForce | null,
): { gauge: React.ReactNode; onBeat: (beat: SceneBeat, at: number) => void } {
  const motion = useRef<ResourceMotion | null>(null);
  const fill = useRef<HTMLSpanElement | null>(null);
  const value = useRef<HTMLSpanElement | null>(null);
  const meter = useRef<HTMLDivElement | null>(null);
  const tick = useRef<HTMLSpanElement | null>(null);
  const lastTicks = useRef(0);

  // The bar's elements are written only here (React renders them once, without dynamic content).
  const paint = useCallback((m: ResourceMotion) => {
    const s = m.snapshot();
    const pct = s.max > 0 ? (s.value / s.max) * 100 : 0;
    fill.current?.style.setProperty('--value', `${pct}%`);
    if (value.current) value.current.textContent = `${Math.round(s.value)} / ${s.max}`;
    meter.current?.setAttribute('aria-valuenow', String(Math.round(s.value)));
    meter.current?.setAttribute('aria-valuemax', String(s.max));
    const t = tick.current;
    if (t) {
      t.classList.toggle('scene__dot--on', s.ticking);
      if (s.ticks !== lastTicks.current) {
        lastTicks.current = s.ticks;
        // Restart the tick's flash (reading offsetWidth flushes the style).
        t.classList.remove('scene__dot--tick');
        void t.offsetWidth;
        t.classList.add('scene__dot--tick');
      }
    }
  }, []);

  const loadoutKey = loadout ? JSON.stringify(loadout.inForce) : '';
  useEffect(() => {
    motion.current = new ResourceMotion(
      classId,
      loadout?.inForce ?? null,
      loadout?.soulFragments ?? 0,
    );
    lastTicks.current = 0;
    paint(motion.current);
    // Only a new loadout (or class) rebuilds the bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, loadoutKey, paint]);

  const onBeat = useCallback(
    (beat: SceneBeat, at: number) => {
      const m = motion.current;
      if (m && m.beat(beat, at)) paint(m);
    },
    [paint],
  );

  const label = RESOURCE_LABEL[classId];
  const gauge = (
    <div className="meter-field scene__resource">
      <div className="meter-field__text" aria-hidden="true">
        <span className="meter-field__name">
          {label}{' '}
          <span ref={tick} className="scene__dot" title="Damage over time">
            ✦
          </span>
        </span>
        <span className="meter-field__value" ref={value} />
      </div>
      <div
        ref={meter}
        className={`meter meter--${variantOf[classId]}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
      >
        <span ref={fill} />
      </div>
    </div>
  );
  return { gauge, onBeat };
}
