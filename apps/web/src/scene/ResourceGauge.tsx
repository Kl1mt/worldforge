import { useCallback, useEffect, useMemo, useState } from 'react';
import { AUTO_SKILLS, getActiveSkill, getClass, type ClassId } from '@worldforge/game-core';
import { apiRequest } from '../lib/api';
import { ResourceMeter } from './ResourceMeter';
import { ResourceMotion, type MotionLoadout } from './resourceMotion';
import { sceneSkillOf, type SceneBeat, type SceneSkill } from './sceneLoop';

/** Ticket 9.2: the part of `GET /characters/:id/skills` the scene reads. */
interface LoadoutInForce {
  inForce: MotionLoadout;
  soulFragments: number;
}

/**
 * The loadout the hero fights with now (for the scene's resource bar and skill effects). A failed
 * read falls back to the default loadout: the scene is flavour, the Skills screen shows the real
 * state and its errors.
 */
export function useLoadoutInForce(characterId: string): LoadoutInForce | null {
  const [state, setState] = useState<LoadoutInForce | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void apiRequest<LoadoutInForce>(`/characters/${characterId}/skills`, {
      signal: abort.signal,
    }).then(
      (r) => {
        if (abort.signal.aborted) return;
        setState(r.ok ? r.value : { inForce: { actives: [], passive: null }, soulFragments: 0 });
      },
      () => {
        // Aborted (left the screen or switched heroes): nothing to show.
      },
    );
    return () => abort.abort();
  }, [characterId]);
  return state;
}

/**
 * The scene's view of a loadout (A.18's `SceneSkill`): the class skill in slot 1 sets the cast
 * rhythm; its damage over time, or else a spender's, the ticks shown on the foe.
 */
export function sceneSkillOfLoadout(classId: ClassId, loadout: MotionLoadout | null): SceneSkill {
  const skills = (loadout?.actives ?? []).flatMap((id) => {
    const s = id ? getActiveSkill(id) : undefined;
    return s && s.classId === classId ? [s] : [];
  });
  const core = skills.find((s) => s.kind === 'core');
  const dot = core?.dot ?? skills.find((s) => s.dot)?.dot;
  return sceneSkillOf({
    classId,
    everyNthAttack: core?.everyNthAttack ?? AUTO_SKILLS[classId].everyNthAttack,
    ...(dot ? { dot } : {}),
  });
}

/**
 * Ticket 9.2: the class resource in the scene's HUD ("Rage 62 / 100"), drawn by A.18's
 * `ResourceMeter`. Its value follows the scene's beats through a `ResourceMotion` (game-core's
 * resource rules under the loadout in force), so it only *suggests* the fight like the scene loop.
 * Returns the meter, the beat listener for `useSceneAnimation` and the scene's skill plan.
 */
export function useResourceGauge(
  classId: ClassId,
  loadout: LoadoutInForce | null,
  animate: boolean,
): {
  gauge: React.ReactNode;
  onBeat: (beat: SceneBeat, at: number) => void;
  skill: SceneSkill;
} {
  const loadoutKey = loadout ? JSON.stringify(loadout.inForce) : '';
  const motion = useMemo(
    () => new ResourceMotion(classId, loadout?.inForce ?? null, loadout?.soulFragments ?? 0),
    // Only a new loadout (or class) rebuilds the bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classId, loadoutKey],
  );
  const [value, setValue] = useState(() => motion.snapshot());
  useEffect(() => setValue(motion.snapshot()), [motion]);

  const onBeat = useCallback(
    (beat: SceneBeat, at: number) => {
      if (motion.beat(beat, at)) {
        const s = motion.snapshot();
        // Only the value redraws the meter (at most a few times a second).
        setValue((prev) => (prev.value === s.value && prev.max === s.max ? prev : s));
      }
    },
    [motion],
  );
  const skill = useMemo(
    () => sceneSkillOfLoadout(classId, loadout?.inForce ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classId, loadoutKey],
  );

  const gauge = (
    <ResourceMeter
      resource={getClass(classId).resource}
      current={value.value}
      max={value.max}
      animate={animate}
      className="scene__resource"
    />
  );
  return { gauge, onBeat, skill };
}
