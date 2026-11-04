import {
  MAX_LEVEL,
  getArea,
  getClass,
  getEnemy,
  xpToNextLevel,
  type AreaDefinition,
  type AreaId,
} from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { classPortrait, type SpriteAsset } from '../content/assets';
import { findAsset } from '../content/world';
import { ItemFrame } from '../components/ItemFrame';
import { LabeledMeter } from '../components/Meter';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { useMediaQuery } from '../components/useMediaQuery';
import { useGame } from '../game/GameProvider';
import type { LogEntry } from '../game/chronicle';
import { formatClock, formatDuration, formatNumber } from '../lib/format';
import { PHONE_QUERY, pixelScale, sceneSpriteScale } from '../lib/pixel';
import { routeHref } from '../lib/route';
import './area.css';

/** Vertical stagger in sprite pixels so the line of foes reads as depth, not a row. */
const LIFTS = [2, 0, 4];
/** Backdrop size when an area has no art yet (the painted fallback keeps the scene's shape). */
const BACKDROP_SIZE = { width: 384, height: 216 };

interface Foe {
  id: string;
  name: string;
  sprite: SpriteAsset | null;
  lift: number;
  weight: number;
}

interface AreaView {
  area: AreaDefinition;
  levels: string;
  backdrop: SpriteAsset | null;
  foes: Foe[];
  totalWeight: number;
}

const VIEWS = new Map<AreaId, AreaView>();

/** Display data for an area (game-core content + art; art may be missing). */
function areaView(areaId: AreaId): AreaView {
  const cached = VIEWS.get(areaId);
  if (cached) return cached;
  const area = getArea(areaId);
  const view: AreaView = {
    area,
    levels: `${area.minLevel}–${area.maxLevel}`,
    backdrop: findAsset(area.assetId),
    foes: area.enemies.map((entry, i) => {
      const def = getEnemy(entry.enemyId);
      return {
        id: def.id,
        name: def.name,
        sprite: findAsset(def.assetId),
        lift: LIFTS[i] ?? 0,
        weight: entry.weight,
      };
    }),
    totalWeight: area.enemies.reduce((sum, e) => sum + e.weight, 0),
  };
  VIEWS.set(areaId, view);
  return view;
}

/** How often a foe shows up, in words, from its spawn weight in the area definition. */
function frequency(weight: number, total: number): string {
  const share = total > 0 ? weight / total : 0;
  if (share >= 0.4) return 'Often seen';
  if (share >= 0.2) return 'Sometimes seen';
  return 'Rarely seen';
}

/** A foe sprite, or a framed silhouette plate while its art is missing. */
function FoeSprite({ foe, scale, alt }: { foe: Foe; scale: number; alt: string }) {
  if (!foe.sprite) {
    return (
      <span
        className="foe-missing"
        style={{ width: 64 * scale, height: 64 * scale }}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
      >
        <span aria-hidden="true">?</span>
      </span>
    );
  }
  return (
    <PixelSprite
      sprite={foe.sprite}
      scale={scale}
      alt={alt}
      mirror={foe.sprite.facing === 'right'}
    />
  );
}

function Scene({ view, phone, farming }: { view: AreaView; phone: boolean; farming: boolean }) {
  const hero = useActiveCharacter();
  const { inventory, activity } = useGame();
  const { area, backdrop, foes, levels } = view;
  const size = backdrop ?? BACKDROP_SIZE;
  const [ref, width] = useElementWidth<HTMLDivElement>(768);
  // Backdrop at ×N (even). Sprites match it on wider screens and stay at ×N/2 on phones.
  const scale = pixelScale(width, size.width, { step: 2, min: 2, max: 4 });
  const spriteScale = sceneSpriteScale(scale, phone);
  const stageWidth = Math.min(Math.floor(width), size.width * scale);
  const stageHeight = size.height * scale;
  const backdropLeft = Math.round((stageWidth - size.width * scale) / 2);

  const maxHealth = inventory.kind === 'ready' ? inventory.value.stats.health : null;
  // The server carries health between settlements (null = full).
  const carried = activity.kind === 'ready' ? (activity.value?.health ?? null) : null;
  const health = maxHealth === null ? null : Math.min(maxHealth, carried ?? maxHealth);
  const xpToNext = hero.level < MAX_LEVEL ? xpToNextLevel(hero.level) : hero.experience;

  return (
    <div className={`scene${phone ? '' : ' scene--wide'}`} ref={ref}>
      <figure
        className={`scene__stage${farming ? '' : ' scene__stage--idle'}`}
        style={{ width: stageWidth || undefined, height: stageHeight }}
        aria-label={
          farming
            ? `${area.name}: ${hero.name} is fighting`
            : `${area.name}: ${hero.name} is resting`
        }
      >
        {backdrop ? (
          <PixelSprite
            sprite={backdrop}
            scale={scale}
            alt=""
            className="scene__backdrop"
            style={{ left: backdropLeft }}
          />
        ) : (
          <span className="scene__backdrop scene__backdrop--missing" aria-hidden="true" />
        )}
        <div className="scene__ground" style={{ ['--px' as string]: `${spriteScale}px` }}>
          <div className="scene__hero">
            <PixelSprite
              sprite={classPortrait(hero.classId)}
              scale={spriteScale}
              alt={`${hero.name}, ${getClass(hero.classId).name.toLowerCase()}`}
            />
          </div>
          <ul className="scene__foes" aria-label="Enemies of the area">
            {foes.map((foe) => (
              <li key={foe.id} className="foe" style={{ marginBottom: foe.lift * spriteScale }}>
                <div
                  className="foe__plate"
                  // Wide: the plate spans the middle of the sprite so neighbours never touch.
                  style={{
                    width: Math.round(
                      (foe.sprite?.width ?? 64) * spriteScale * (phone ? 1 : 0.625),
                    ),
                  }}
                >
                  <span className="foe__name">{foe.name}</span>
                  <span className="foe__level">Lv {levels}</span>
                </div>
                <FoeSprite foe={foe} scale={spriteScale} alt={`${foe.name}, level ${levels}`} />
              </li>
            ))}
          </ul>
        </div>
        <figcaption className="scene__hud">
          <span className="scene__hud-name">{hero.name}</span>
          {health !== null && maxHealth !== null ? (
            <LabeledMeter
              current={health}
              max={maxHealth}
              label="Health"
              value={`${formatNumber(health)} / ${formatNumber(maxHealth)}`}
            />
          ) : (
            <span className="scene__hud-wait">Health …</span>
          )}
          <LabeledMeter
            current={hero.experience}
            max={xpToNext}
            label={`Level ${hero.level}`}
            value={`${formatNumber(hero.experience)} / ${formatNumber(xpToNext)} XP`}
            variant="xp"
          />
        </figcaption>
      </figure>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case 'kill':
      return (
        <>
          <span className="log__kill">
            {entry.kills === 1 ? 'A foe falls.' : `${formatNumber(entry.kills)} foes fall.`}
          </span>{' '}
          <span className="log__dim">+{formatNumber(entry.xp)} XP</span>
        </>
      );
    case 'loot':
      return (
        <>
          Found <span className={`log__loot rarity-${entry.rarity}`}>[{entry.item}]</span>
        </>
      );
    case 'gold':
      return <span className="log__gold">+{formatNumber(entry.amount)} gold</span>;
    case 'level':
      return (
        <span className="log__level">
          {entry.levels === 1 ? 'Level up.' : `${entry.levels} levels gained.`}
        </span>
      );
    case 'materials':
      return (
        <>
          Gathered{' '}
          {entry.materials.map((m, i) => (
            <span key={m.name}>
              {i > 0 ? ', ' : ''}
              <span className={`log__material rarity-${m.rarity}`}>
                {formatNumber(m.quantity)} {m.name}
              </span>
            </span>
          ))}
        </>
      );
    case 'profession':
      return (
        <span className="log__level">
          {entry.profession} {entry.levels === 1 ? 'improves.' : `+${entry.levels} levels.`}
        </span>
      );
    case 'death':
      return (
        <span className="log__hurt">
          {entry.deaths === 1 ? 'You fell and rose again.' : `You fell ${entry.deaths} times.`}
        </span>
      );
    case 'note':
      return <span className="log__note">{entry.text}</span>;
  }
}

function CombatLog({ farming, areaName }: { farming: boolean; areaName: string }) {
  const { chronicle } = useGame();
  return (
    <section className="log panel-ledger" aria-labelledby="log-title">
      <header className="log__head">
        <h2 id="log-title" className="display">
          Chronicle
        </h2>
        <span className="caps">Newest first</span>
      </header>
      {chronicle.length === 0 ? (
        <p className="log__empty">
          {farming
            ? `Steel rings somewhere in ${areaName}. The first report arrives within seconds.`
            : 'All is quiet. Send your hero out and the Chronicle fills as the fights are settled.'}
        </p>
      ) : (
        <ol className="log__list" aria-live="polite" aria-relevant="additions">
          {chronicle.map((entry) => (
            <li key={entry.id} className={`log__row log__row--${entry.kind}`}>
              <time className="log__time" dateTime={entry.at}>
                {formatClock(entry.at)}
              </time>
              <p>
                <LogLine entry={entry} />
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Spoils({ smallArt }: { smallArt: number }) {
  const { inventory } = useGame();
  let body;
  if (inventory.kind === 'loading') {
    body = <p className="spoils__note">Counting the spoils…</p>;
  } else if (inventory.kind === 'error') {
    body = <p className="spoils__note">The pack cannot be reached right now.</p>;
  } else {
    const recent = [...inventory.value.items]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6);
    body =
      recent.length === 0 ? (
        <p className="spoils__note">Nothing found yet. Drops land in your pack.</p>
      ) : (
        <ul className="spoils__list">
          {recent.map((item) => (
            <li key={item.id}>
              <ItemFrame item={item} scale={smallArt} context="Recent drop" />
            </li>
          ))}
        </ul>
      );
  }
  return (
    <section className="spoils" aria-labelledby="spoils-title">
      <h2 id="spoils-title" className="rule-heading">
        Recent spoils
      </h2>
      {body}
      {inventory.kind === 'ready' && inventory.value.items.length > 0 ? (
        <a className="spoils__link" href={routeHref('inventory')}>
          Open the pack
        </a>
      ) : null}
    </section>
  );
}

function FarmControl({ farming, view }: { farming: boolean; view: AreaView }) {
  const hero = useActiveCharacter();
  const { activity, farmBusy, startFarming, stopFarming, reload } = useGame();
  const locked = hero.level < view.area.unlock.level;
  if (activity.kind === 'loading') {
    return (
      <p className="area__wait" role="status">
        Reading the field reports…
      </p>
    );
  }
  if (activity.kind === 'error') {
    return (
      <div className="area__alert" role="alert">
        <p>{activity.message}</p>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!farming && locked) {
    return (
      <a className="btn area__action" href={routeHref('map')}>
        Choose an area on the map
      </a>
    );
  }
  return farming ? (
    <button
      type="button"
      className="btn area__action"
      onClick={() => void stopFarming()}
      disabled={farmBusy}
      aria-busy={farmBusy}
    >
      {farmBusy ? 'Calling back…' : `Call ${hero.name} back`}
    </button>
  ) : (
    <button
      type="button"
      className="btn btn--brass area__action"
      onClick={() => void startFarming(view.area.id)}
      disabled={farmBusy}
      aria-busy={farmBusy}
    >
      {farmBusy ? 'Setting out…' : `Farm ${view.area.name}`}
    </button>
  );
}

export function AreaScreen() {
  const phone = useMediaQuery(PHONE_QUERY);
  const { activity, tally, farmError, areaId } = useGame();
  const view = areaView(areaId);
  const { area, levels, foes, totalWeight } = view;
  const farming = activity.kind === 'ready' && activity.value !== null;
  const pending =
    activity.kind === 'ready' && activity.value?.pendingAreaId
      ? getArea(activity.value.pendingAreaId)
      : null;
  // Roster figures and spoils icons: ×1 on phones (approved), ×2 on wider screens.
  const smallArt = phone ? 1 : 2;
  const minutes = tally.simulatedMs / 60_000;
  const pace = minutes >= 1 ? (tally.kills / minutes).toFixed(1) : '—';

  return (
    <div className={`area${phone ? '' : ' area--wide'}`}>
      <header className="area__head">
        <p className="area__region caps">
          {area.region} <span aria-hidden="true">·</span> Levels {levels}{' '}
          <span aria-hidden="true">·</span>{' '}
          <a className="area__maplink" href={routeHref('map')}>
            World map
          </a>
        </p>
        <h1 className="area__title display">{area.name}</h1>
        <p className="area__desc">{area.description}</p>
        {pending ? (
          <p className="area__travel" role="status">
            Travelling to <strong>{pending.name}</strong> once this fight is over.
          </p>
        ) : null}
        <div className="area__controls">
          <dl className="area__pace">
            <div>
              <dt>Status</dt>
              <dd className={farming ? 'area__fighting' : 'area__resting'}>
                {farming ? 'Fighting' : 'Resting'}
              </dd>
            </div>
            <div>
              <dt>Kills / min</dt>
              <dd>{pace}</dd>
            </div>
            <div>
              <dt title={`Fought ${formatDuration(tally.simulatedMs)} this visit`}>
                Drops this visit
              </dt>
              <dd>{formatNumber(tally.items)}</dd>
            </div>
          </dl>
          <FarmControl farming={farming} view={view} />
        </div>
        {farmError ? (
          <p className="area__alert area__alert--line" role="alert">
            {farmError}
          </p>
        ) : null}
      </header>

      <div className="area__grid">
        <Scene view={view} phone={phone} farming={farming} />
        <div className="area__log">
          <CombatLog farming={farming} areaName={area.name} />
        </div>

        <section className="roster" aria-labelledby="roster-title">
          <h2 id="roster-title" className="rule-heading">
            Foes of {area.name}
          </h2>
          <ul className="roster__list">
            {foes.map((foe) => (
              <li key={foe.id} className="roster__foe">
                <span className="roster__plinth">
                  <FoeSprite foe={foe} scale={smallArt} alt="" />
                </span>
                <span className="roster__name">{foe.name}</span>
                <span className="roster__count">{frequency(foe.weight, totalWeight)}</span>
              </li>
            ))}
          </ul>
        </section>

        <Spoils smallArt={smallArt} />
      </div>
    </div>
  );
}
