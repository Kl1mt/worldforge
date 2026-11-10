import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { useMediaQuery } from '../components/useMediaQuery';
import { PHONE_QUERY, pixelScale, sceneSpriteScale } from '../lib/pixel';
import { SceneActor } from '../scene/SceneActor';
import { applyBeat, type ActorLayers } from '../scene/sceneDriver';
import type { SceneBeat } from '../scene/sceneLoop';
import { layersOf, useSceneAnimation, useSceneMotion } from '../scene/useSceneAnimation';
import {
  GALLERY_SCALES,
  GALLERY_SPEEDS,
  filterCatalogue,
  galleryCatalogue,
  galleryImages,
  type GalleryCatalogue,
  type GalleryEnemy,
  type GalleryHero,
} from './gallery';
import '../screens/area.css';
import './animation-gallery.css';

/** One sprite frame at 12 fps: what "Step" advances a paused animation by. */
const STEP_MS = 80;

/**
 * Ticket A.14c: the admin animation gallery. Every hero class, every enemy and every backdrop,
 * with buttons that fire the scene's real beats on one sprite, global play / pause / step, speed
 * and scale, and a scene preview that runs the real farming loop. Assets only: no player data, no
 * requests, no gameplay. Under reduced motion or automation it stays frozen until the admin
 * presses Play; only then (and only inside the gallery) is motion forced on.
 */
export function AnimationGallery() {
  const catalogue = useMemo(() => galleryCatalogue(), []);
  const motion = useSceneMotion();
  // Frozen at first unless this browser runs full motion; Play arms it for good.
  const [armed, setArmed] = useState(motion === 'full');
  const [playing, setPlaying] = useState(motion === 'full');
  const [speed, setSpeed] = useState<number>(1);
  const [scale, setScale] = useState<number>(2);
  const [breath, setBreath] = useState(true);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterCatalogue(catalogue, query), [catalogue, query]);
  const images = useImages(useMemo(() => galleryImages(catalogue), [catalogue]));
  const root = useRef<HTMLDivElement>(null);
  usePlayback(root, playing, speed);
  const forced = armed && motion !== 'full';
  const searchId = useId();

  const play = () => {
    setArmed(true);
    setPlaying(true);
  };
  const step = () => {
    setPlaying(false);
    for (const a of root.current?.getAnimations({ subtree: true }) ?? []) {
      a.pause();
      a.currentTime = Number(a.currentTime ?? 0) + STEP_MS;
    }
  };

  const enemyCount = catalogue.groups.reduce((n, g) => n + g.enemies.length, 0);
  const rootClass = [
    'anim-gallery',
    armed ? 'scene-anim' : '',
    forced ? 'scene-anim--forced' : '',
    breath ? '' : 'anim-gallery--still',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} ref={root} style={{ ['--px' as string]: `${scale}px` }}>
      <header className="anim-gallery__head">
        <p className="caps">Animations · assets only, nothing here reaches the server</p>
        <p className="anim-gallery__lede">
          {catalogue.heroes.length} classes, {enemyCount} foes in {catalogue.groups.length} places.
          Fire any beat on one sprite, or run the real farming loop in the scene preview.
        </p>
        {!armed ? (
          <p className="anim-gallery__frozen" role="status">
            {motion === 'reduced'
              ? 'This browser asks for reduced motion, so the gallery is still. Press Play to animate it here only.'
              : 'Motion is off in this browser (automation). Press Play to animate the gallery.'}
          </p>
        ) : null}
      </header>

      <div className="anim-gallery__bar" role="toolbar" aria-label="Playback">
        {playing && armed ? (
          <button type="button" className="btn" onClick={() => setPlaying(false)}>
            Pause
          </button>
        ) : (
          <button type="button" className="btn btn--brass" onClick={play}>
            Play
          </button>
        )}
        <button type="button" className="btn" onClick={step} disabled={!armed}>
          Step
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={breath}
          onClick={() => setBreath((b) => !b)}
        >
          Idle breath
        </button>
        <Choice
          label="Speed"
          options={GALLERY_SPEEDS}
          value={speed}
          onChange={setSpeed}
          format={(v) => `${v}×`}
        />
        <Choice
          label="Scale"
          options={GALLERY_SCALES}
          value={scale}
          onChange={setScale}
          format={(v) => `×${v}`}
        />
        <label className="anim-gallery__search" htmlFor={searchId}>
          <span className="caps">Find</span>
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="wolf, warden, verge…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <ImageStatus images={images} />

      <ScenePreview
        catalogue={catalogue}
        armed={armed}
        motionFull={motion === 'full'}
        rate={speed}
      />

      {shown.heroes.length === 0 && shown.groups.length === 0 ? (
        <div className="anim-gallery__empty" role="status">
          <p>No sprite matches “{query}”.</p>
          <button type="button" className="btn" onClick={() => setQuery('')}>
            Show everything
          </button>
        </div>
      ) : null}

      {shown.heroes.length > 0 ? (
        <section className="anim-gallery__group" aria-label="Heroes">
          <h2 className="rule-heading anim-gallery__title">Heroes</h2>
          <ul className="anim-gallery__cards">
            {shown.heroes.map((h) => (
              <SpriteCard key={h.key} hero={h} scale={scale} />
            ))}
          </ul>
        </section>
      ) : null}

      {shown.groups.map((g) => (
        <section key={g.id} className="anim-gallery__group" aria-label={g.title}>
          <h2 className="rule-heading anim-gallery__title">
            {g.title} <span className="anim-gallery__note">{g.note}</span>
          </h2>
          {g.backdrops.length > 0 ? (
            <ul className="anim-gallery__backdrops">
              {g.backdrops.map((b) => (
                <li key={b.assetId} className="anim-gallery__backdrop">
                  {b.sprite ? (
                    <PixelSprite sprite={b.sprite} scale={1} alt={`Backdrop ${b.assetId}`} />
                  ) : (
                    <span className="anim-gallery__missing">No art</span>
                  )}
                  <code>{b.assetId}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {g.enemies.length > 0 ? (
            <ul className="anim-gallery__cards">
              {g.enemies.map((e) => (
                <SpriteCard key={e.key} enemy={e} scale={scale} />
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/** A small radio group of buttons. */
function Choice<T extends number>({
  label,
  options,
  value,
  onChange,
  format,
}: {
  label: string;
  options: readonly T[];
  value: number;
  onChange: (v: T) => void;
  format: (v: T) => string;
}) {
  return (
    <span className="anim-gallery__choice" role="radiogroup" aria-label={label}>
      <span className="caps">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          className="btn btn--small"
          aria-checked={value === o}
          aria-pressed={value === o}
          onClick={() => onChange(o)}
        >
          {format(o)}
        </button>
      ))}
    </span>
  );
}

/** One sprite with its beat buttons; beats go through the scene's own `applyBeat`. */
function SpriteCard({
  hero,
  enemy,
  scale,
}: {
  hero?: GalleryHero;
  enemy?: GalleryEnemy;
  scale: number;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const isHero = hero !== undefined;
  const name = hero?.name ?? enemy?.name ?? '';
  const sheet = hero?.sheet ?? enemy?.sheet ?? null;
  const still = hero?.still ?? enemy?.still ?? null;
  const sprite = sheet ?? still;

  const fire = useCallback(
    (beat: SceneBeat) => {
      const layers: ActorLayers | null = layersOf(ref.current);
      applyBeat(beat, { hero: layers, foes: [layers] });
    },
    [ref],
  );

  return (
    <li className={`anim-gallery__card${enemy?.boss ? ' anim-gallery__card--boss' : ''}`}>
      <div className="anim-gallery__stage">
        <SceneActor role={isHero ? 'hero' : 'foe'} framed={sheet !== null} actorRef={ref}>
          {sprite ? (
            <PixelSprite
              sprite={sprite}
              {...(still && sheet ? { fallback: still } : {})}
              scale={scale}
              alt={name}
              mirror={sprite.facing === 'right'}
            />
          ) : (
            <span className="anim-gallery__missing">No art</span>
          )}
        </SceneActor>
      </div>
      <div className="anim-gallery__caption">
        <span className="anim-gallery__name">{name}</span>
        <span className={`anim-gallery__tag${sheet ? ' anim-gallery__tag--frames' : ''}`}>
          {sheet ? 'Has frames' : 'Code only'}
        </span>
        <code>{hero ? `character.${hero.classId}` : enemy?.assetId}</code>
      </div>
      <div className="anim-gallery__beats" role="group" aria-label={`${name}: play a beat`}>
        <button
          type="button"
          className="btn btn--small"
          onClick={() =>
            fire(isHero ? { kind: 'heroStrike', foe: 0 } : { kind: 'foeStrike', foe: 0 })
          }
        >
          Attack
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() =>
            fire(isHero ? { kind: 'heroHit' } : { kind: 'foeHit', foe: 0, heavy: false })
          }
        >
          Hit
        </button>
        {isHero ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => fire({ kind: 'heroGlow' })}
          >
            Level-up glow
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => fire({ kind: 'foeHit', foe: 0, heavy: true })}
            >
              Heavy hit
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => fire({ kind: 'foeFall', foe: 0 })}
            >
              Defeat
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => fire({ kind: 'foeRise', foe: 0 })}
            >
              Respawn
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The scene preview: a backdrop, a hero class and up to three foes in the real scene markup, run
 * by the real loop (`useSceneAnimation`) at the gallery's speed.
 */
function ScenePreview({
  catalogue,
  armed,
  motionFull,
  rate,
}: {
  catalogue: GalleryCatalogue;
  armed: boolean;
  motionFull: boolean;
  rate: number;
}) {
  const backdrops = useMemo(
    () => catalogue.groups.flatMap((g) => g.backdrops.filter((b) => b.sprite)),
    [catalogue],
  );
  const enemies = useMemo(
    () =>
      catalogue.groups.flatMap((g) =>
        g.enemies
          .filter((e) => e.still)
          .map((e) => ({ ...e, group: g.title, id: `${g.id}/${e.key}` })),
      ),
    [catalogue],
  );
  const first = catalogue.groups[0];
  const [backdropId, setBackdropId] = useState(backdrops[0]?.assetId ?? '');
  const [classId, setClassId] = useState(catalogue.heroes[0]?.classId ?? 'warrior');
  const [foeIds, setFoeIds] = useState<string[]>(
    (first?.enemies ?? []).slice(0, 3).map((e) => `${first!.id}/${e.key}`),
  );
  const [running, setRunning] = useState(false);
  const [ref, width] = useElementWidth<HTMLDivElement>(768);
  const phone = useMediaQuery(PHONE_QUERY);
  const ids = useId();

  const backdrop = backdrops.find((b) => b.assetId === backdropId)?.sprite ?? null;
  const hero = catalogue.heroes.find((h) => h.classId === classId) ?? catalogue.heroes[0]!;
  const foes = foeIds
    .map((id) => enemies.find((e) => e.id === id))
    .filter((e): e is (typeof enemies)[number] => e !== undefined);
  const size = backdrop ?? { width: 384, height: 216 };
  const scale = pixelScale(width, size.width, { step: 2, min: 2, max: 4 });
  // The area screen's own rule: sprites at the backdrop's scale off-phone, half of it on phones.
  const spriteScale = sceneSpriteScale(scale, phone);
  const stageWidth = Math.min(Math.floor(width), size.width * scale);

  const { heroRef, foeRef } = useSceneAnimation({
    active: running,
    motion: armed || motionFull ? 'full' : 'off',
    foes: foes.length,
    attackSpeed: hero.attackSpeed,
    framed: hero.sheet !== null,
    framedFoes: foes.map((f) => f.sheet !== null),
    rate,
  });

  const setFoe = (slot: number, id: string) =>
    setFoeIds((list) => {
      const next = [...list];
      next[slot] = id;
      return next.filter(Boolean).slice(0, 3);
    });

  return (
    <section className="anim-gallery__preview" aria-label="Scene preview">
      <h2 className="rule-heading anim-gallery__title">Scene preview</h2>
      <div className="anim-gallery__pickers">
        <label htmlFor={`${ids}-bd`}>
          <span className="caps">Backdrop</span>
          <select
            id={`${ids}-bd`}
            value={backdropId}
            onChange={(e) => setBackdropId(e.target.value)}
          >
            {backdrops.map((b) => (
              <option key={b.assetId} value={b.assetId}>
                {b.assetId}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${ids}-hero`}>
          <span className="caps">Hero</span>
          <select
            id={`${ids}-hero`}
            value={classId}
            onChange={(e) => setClassId(e.target.value as typeof classId)}
          >
            {catalogue.heroes.map((h) => (
              <option key={h.classId} value={h.classId}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        {[0, 1, 2].map((slot) => (
          <label key={slot} htmlFor={`${ids}-foe${slot}`}>
            <span className="caps">Foe {slot + 1}</span>
            <select
              id={`${ids}-foe${slot}`}
              value={foeIds[slot] ?? ''}
              onChange={(e) => setFoe(slot, e.target.value)}
            >
              <option value="">— none —</option>
              {catalogue.groups.map((g) => (
                <optgroup key={g.id} label={g.title}>
                  {g.enemies
                    .filter((e) => e.still)
                    .map((e) => (
                      <option key={e.key} value={`${g.id}/${e.key}`}>
                        {e.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        ))}
        <button
          type="button"
          className={`btn${running ? '' : ' btn--brass'}`}
          onClick={() => setRunning((r) => !r)}
          disabled={!armed && !motionFull}
        >
          {running ? 'Stop the fight' : 'Run the fight'}
        </button>
      </div>
      <div className={`scene${phone ? '' : ' scene--wide'} anim-gallery__scene`} ref={ref}>
        <figure
          className="scene__stage"
          style={{ width: stageWidth || undefined, height: size.height * scale }}
          aria-label={`Scene preview: ${hero.name} against ${foes.map((f) => f.name).join(', ') || 'nobody'}`}
        >
          {backdrop ? (
            <PixelSprite
              sprite={backdrop}
              scale={scale}
              alt=""
              className="scene__backdrop"
              style={{ left: Math.round((stageWidth - size.width * scale) / 2) }}
            />
          ) : (
            <span className="scene__backdrop scene__backdrop--missing" aria-hidden="true" />
          )}
          <div className="scene__ground" style={{ ['--px' as string]: `${spriteScale}px` }}>
            <div className="scene__hero">
              <SceneActor role="hero" framed={hero.sheet !== null} actorRef={heroRef}>
                <PixelSprite
                  sprite={hero.sheet ?? hero.still}
                  fallback={hero.still}
                  scale={spriteScale}
                  alt={hero.name}
                />
              </SceneActor>
            </div>
            <ul className="scene__foes">
              {foes.map((f, i) => {
                const sprite = f.sheet ?? f.still!;
                return (
                  <li key={`${f.id}-${i}`} className="foe">
                    <div className="foe__plate">
                      <span className="foe__name">{f.name}</span>
                    </div>
                    <SceneActor role="foe" index={i} framed={f.sheet !== null} actorRef={foeRef(i)}>
                      <PixelSprite
                        sprite={sprite}
                        fallback={f.still!}
                        scale={spriteScale}
                        alt={f.name}
                        mirror={sprite.facing === 'right'}
                      />
                    </SceneActor>
                  </li>
                );
              })}
            </ul>
          </div>
        </figure>
      </div>
    </section>
  );
}

/**
 * Pauses, resumes and re-speeds every CSS animation under `root` through the Web Animations API,
 * including ones that start later (a beat fired while paused starts paused).
 */
function usePlayback(root: RefObject<HTMLElement | null>, playing: boolean, rate: number) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof el.getAnimations !== 'function') return;
    const apply = () => {
      for (const a of el.getAnimations({ subtree: true })) {
        a.playbackRate = rate;
        if (playing && a.playState === 'paused') a.play();
        else if (!playing && a.playState === 'running') a.pause();
      }
    };
    apply();
    el.addEventListener('animationstart', apply);
    return () => el.removeEventListener('animationstart', apply);
  }, [root, playing, rate]);
}

interface ImageLoad {
  total: number;
  loaded: number;
  failed: string[];
}

/** Loads every image once, for the loading and error states. */
function useImages(paths: string[]): ImageLoad {
  const [state, setState] = useState<ImageLoad>({ total: paths.length, loaded: 0, failed: [] });
  useEffect(() => {
    // `paths` is the catalogue's fixed list (memoised once), so the initial state stands.
    let live = true;
    for (const path of paths) {
      const img = new Image();
      img.onload = () => live && setState((s) => ({ ...s, loaded: s.loaded + 1 }));
      img.onerror = () =>
        live && setState((s) => ({ ...s, loaded: s.loaded + 1, failed: [...s.failed, path] }));
      img.src = path;
    }
    return () => {
      live = false;
    };
  }, [paths]);
  return state;
}

function ImageStatus({ images }: { images: ImageLoad }) {
  if (images.failed.length > 0) {
    return (
      <div className="gate__alert anim-gallery__alert" role="alert">
        {images.failed.length} image{images.failed.length === 1 ? '' : 's'} failed to load:{' '}
        {images.failed.map((p) => p.replace(/^\/assets\//, '')).join(', ')}.
      </div>
    );
  }
  if (images.loaded < images.total) {
    return (
      <p className="anim-gallery__loading" role="status">
        Loading the art… {images.loaded} / {images.total}
      </p>
    );
  }
  return null;
}
