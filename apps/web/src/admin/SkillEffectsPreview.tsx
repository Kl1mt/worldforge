import { RESOURCE_RULES } from '@worldforge/game-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelSprite } from '../components/PixelSprite';
import type { SpriteAsset } from '../content/assets';
import { ResourceMeter } from '../scene/ResourceMeter';
import { SceneActor } from '../scene/SceneActor';
import { applyBeat } from '../scene/sceneDriver';
import { DOT_KINDS, TICK_MS, type DotKind, type SceneBeat } from '../scene/sceneLoop';
import { layersOf } from '../scene/useSceneAnimation';
import { nextSampleValue, sampleStart, type GalleryHero, type GallerySkillClass } from './gallery';

/** Steps of the resource sample, at 1× speed. */
const SAMPLE_STEP_MS = 700;

const DOT_LABEL: Record<DotKind, string> = { burn: 'Burn', bleed: 'Bleed', shadow: 'Shadow' };

/**
 * Ticket A.18: the skill art and effects, per class: the twelve skill icons, the cast flash on the
 * hero, the three damage-over-time ticks on a target, and the class's resource meter filling and
 * spending. Every effect goes through the scene's own code (`applyBeat`, `ResourceMeter`) with
 * sample events, so it needs no server, no player and no fight. Timers run only on a button press.
 */
export function SkillEffectsPreview({
  classes,
  heroes,
  target,
  scale,
  armed,
  rate,
}: {
  classes: GallerySkillClass[];
  heroes: GalleryHero[];
  /** Any foe with art: the target of the ticks. */
  target: { name: string; sprite: SpriteAsset } | null;
  scale: number;
  /** Motion allowed (full motion, or the admin pressed Play). */
  armed: boolean;
  /** The gallery's speed (0.25×–1×). */
  rate: number;
}) {
  return (
    <section className="anim-gallery__group" aria-label="Skill effects">
      <h2 className="rule-heading anim-gallery__title">
        Skills{' '}
        <span className="anim-gallery__note">
          icons, cast flash, damage over time, resource meter
        </span>
      </h2>
      <ul className="anim-gallery__skills">
        {classes.map((c) => {
          const hero = heroes.find((h) => h.classId === c.classId);
          return (
            <SkillClassCard
              key={c.classId}
              skills={c}
              hero={hero ?? null}
              target={target}
              scale={scale}
              armed={armed}
              rate={rate}
            />
          );
        })}
      </ul>
    </section>
  );
}

function SkillClassCard({
  skills,
  hero,
  target,
  scale,
  armed,
  rate,
}: {
  skills: GallerySkillClass;
  hero: GalleryHero | null;
  target: { name: string; sprite: SpriteAsset } | null;
  scale: number;
  armed: boolean;
  rate: number;
}) {
  const heroEl = useRef<HTMLSpanElement | null>(null);
  const foeEl = useRef<HTMLSpanElement | null>(null);
  const timers = useRef<number[]>([]);
  const fire = useCallback((beat: SceneBeat) => {
    applyBeat(beat, { hero: layersOf(heroEl.current), foes: [layersOf(foeEl.current)] });
  }, []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms / (rate > 0 ? rate : 1)));
  };
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );

  /** The class's own skill in full: the cast, its blow, then its ticks once a second. */
  const castWithTicks = () => {
    const { dot, ticks = 4 } = skills.dotSkill;
    fire({ kind: 'heroCast' });
    fire({ kind: 'heroStrike', foe: 0 });
    later(() => fire({ kind: 'foeHit', foe: 0, heavy: false }), 180);
    if (!dot) return;
    for (let k = 1; k <= ticks; k++)
      later(() => fire({ kind: 'foeTick', foe: 0, dot }), 180 + k * TICK_MS);
  };

  const max = RESOURCE_RULES[skills.classId].max;
  const [value, setValue] = useState(() => sampleStart(skills.classId));
  const [sampling, setSampling] = useState(false);
  const spentLast = useRef(false);
  const step = useCallback(() => {
    setValue((v) => {
      const next = nextSampleValue(skills.classId, v, spentLast.current);
      spentLast.current = next < v;
      return next;
    });
  }, [skills.classId]);
  useEffect(() => {
    if (!sampling) return;
    const id = window.setInterval(step, SAMPLE_STEP_MS / (rate > 0 ? rate : 1));
    return () => window.clearInterval(id);
  }, [sampling, step, rate]);

  const sprite = hero ? (hero.sheet ?? hero.still) : null;
  return (
    <li className="anim-gallery__skill-card">
      <h3 className="anim-gallery__skill-class">
        {skills.name} <span className="anim-gallery__note">{skills.skills.length} skills</span>
      </h3>
      <ul className="anim-gallery__skill-icons" aria-label={`${skills.name} skills`}>
        {skills.skills.map((s) => (
          <li key={s.id} className="anim-gallery__skill-icon" title={`${s.name} · ${s.unlock}`}>
            {s.icon ? (
              <PixelSprite sprite={s.icon} scale={Math.max(1, scale)} alt={s.name} />
            ) : (
              <span className="anim-gallery__missing">No art</span>
            )}
            <span className="anim-gallery__skill-name">{s.name}</span>
            <span className="anim-gallery__skill-meta">
              {s.kind === 'passive' ? 'Passive' : s.kind === 'core' ? 'Core' : 'Spender'} ·{' '}
              {s.unlock}
            </span>
          </li>
        ))}
      </ul>

      <div className="anim-gallery__skill-stage">
        <SceneActor
          role="hero"
          framed={hero?.sheet != null}
          cast={skills.classId}
          actorRef={heroEl}
        >
          {sprite && hero ? (
            <PixelSprite sprite={sprite} fallback={hero.still} scale={scale} alt={hero.name} />
          ) : (
            <span className="anim-gallery__missing">No art</span>
          )}
        </SceneActor>
        <SceneActor role="foe" actorRef={foeEl}>
          {target ? (
            <PixelSprite
              sprite={target.sprite}
              scale={scale}
              alt={target.name}
              mirror={target.sprite.facing === 'right'}
            />
          ) : (
            <span className="anim-gallery__missing">No art</span>
          )}
        </SceneActor>
      </div>

      <div
        className="anim-gallery__beats"
        role="group"
        aria-label={`${skills.name}: skill effects`}
      >
        <button type="button" className="btn btn--small" onClick={() => fire({ kind: 'heroCast' })}>
          Cast
        </button>
        <button type="button" className="btn btn--small" onClick={castWithTicks} disabled={!armed}>
          Cast + {skills.dotSkill.dot ? DOT_LABEL[skills.dotSkill.dot].toLowerCase() : 'blow'}
        </button>
        {DOT_KINDS.map((dot) => (
          <button
            key={dot}
            type="button"
            className="btn btn--small"
            onClick={() => fire({ kind: 'foeTick', foe: 0, dot })}
          >
            {DOT_LABEL[dot]} tick
          </button>
        ))}
      </div>

      <ResourceMeter
        resource={skills.resource}
        current={value}
        max={max}
        animate={armed}
        className="anim-gallery__resource"
      />
      <div className="anim-gallery__beats" role="group" aria-label={`${skills.name}: resource`}>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => setValue((v) => Math.min(max, v + Math.max(1, Math.round(max / 5))))}
        >
          Fill
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => setValue((v) => Math.max(0, v - Math.max(1, Math.round(max / 2))))}
        >
          Spend
        </button>
        <button
          type="button"
          className={`btn btn--small${sampling ? '' : ' btn--brass'}`}
          aria-pressed={sampling}
          onClick={() => setSampling((s) => !s)}
          disabled={!armed}
        >
          {sampling ? 'Stop the sample' : 'Run a sample'}
        </button>
      </div>
    </li>
  );
}
