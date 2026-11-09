import { useState } from 'react';
import {
  AREAS,
  DUNGEONS,
  getArea,
  getEnemy,
  getWorldFlag,
  type AreaId,
  type DungeonId,
  type UnlockBlocker,
} from '@worldforge/game-core';
import { asset } from '../content/assets';
import { DUNGEON_WORDS } from '../content/dungeons';
import { MAP_MARKERS, type MapPlaceId } from '../content/world';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { useMediaQuery } from '../components/useMediaQuery';
import { useGame } from '../game/GameProvider';
import type { WorldState } from '../game/api';
import { PHONE_QUERY, pixelScale } from '../lib/pixel';
import { routeHref } from '../lib/route';
import { Trail } from '../shell/Trail';
import './map.css';

const MAP = asset('map.graumark');
/** Ledger column and gap beside the map (map.css); stacked below 1080 px. */
const LEDGER_WIDTH = 340;
const GAP = 24;
const WIDE_QUERY = '(min-width: 1081px)';

type PlaceId = AreaId | DungeonId;
/**
 * current = fighting there; next = travelling there after this fight; sealed = closed for
 * everyone until the town finishes a community project (ticket 4.8: a world-flag blocker), or a
 * dungeon the server marks as not yet available.
 */
type PlaceState = 'current' | 'next' | 'open' | 'locked' | 'sealed' | 'unknown';

interface Place {
  id: PlaceId;
  kind: 'area' | 'dungeon';
  name: string;
  description: string;
  levels: string;
  foes: string[];
  state: PlaceState;
  blockers: UnlockBlocker[];
}

const PLACES_BASE = [
  ...AREAS.map((a) => ({
    id: a.id as PlaceId,
    kind: 'area' as const,
    name: a.name,
    description: a.description,
    levels: `${a.minLevel}–${a.maxLevel}`,
    foes: a.enemies.map((e) => getEnemy(e.enemyId).name),
  })),
  ...DUNGEONS.map((d) => ({
    id: d.id as PlaceId,
    kind: 'dungeon' as const,
    name: d.name,
    description: d.description,
    // Ticket 3.6: tier I's entry to the deepest tier's top.
    levels: `${d.tiers[0]!.minLevel}–${d.tiers.at(-1)!.maxLevel}`,
    foes: [...d.enemies.map((e) => getEnemy(e.enemyId).name), getEnemy(d.bossId).name],
  })),
];

function places(world: WorldState | null, current: AreaId | null, pending: AreaId | null): Place[] {
  return PLACES_BASE.map((p) => {
    const w =
      p.kind === 'area'
        ? world?.areas.find((a) => a.id === p.id)
        : world?.dungeons.find((d) => d.id === p.id);
    let state: PlaceState = 'unknown';
    if (p.id === current) state = 'current';
    else if (p.id === pending) state = 'next';
    else if (w) {
      const unavailable = p.kind === 'dungeon' && !(w as { available?: boolean }).available;
      const sealed = w.blockers.some((b) => b.kind === 'worldFlag');
      state = sealed ? 'sealed' : !w.unlocked ? 'locked' : unavailable ? 'sealed' : 'open';
    }
    return { ...p, state, blockers: w?.blockers ?? [] };
  });
}

function blockerText(b: UnlockBlocker): string {
  if (b.kind === 'level') return `Reach level ${b.required}`;
  // Ticket 4.6: a community project must finish first.
  if (b.kind === 'worldFlag') return getWorldFlag(b.flag).lockedText;
  if (b.kind === 'cryptTier') return `Clear Tier ${'I'.repeat(b.tier)} of the crypt`;
  // Ticket 6.1: the Cinderwastes lie past the Warden's tower.
  if (b.kind === 'ashenWardenDefeated') return 'Defeat the Ashen Warden';
  return 'Defeat the Gravewarden';
}

const STATE_LABEL: Record<PlaceState, string> = {
  current: 'You are here',
  next: 'Next',
  open: 'Open',
  locked: 'Locked',
  sealed: 'Sealed',
  unknown: '…',
};

function Marker({
  id,
  label,
  state,
  selected,
  scale,
  left,
  phone,
  onSelect,
}: {
  id: MapPlaceId;
  label: string;
  state: PlaceState | 'town';
  selected: boolean;
  scale: number;
  left: number;
  phone: boolean;
  onSelect: () => void;
}) {
  const m = MAP_MARKERS.find((x) => x.id === id)!;
  const style = { left: left + m.x * scale, top: m.y * scale };
  const cls = `marker marker--${state}${selected ? ' marker--selected' : ''}`;
  const inner = (
    <>
      <span className="marker__pin" />
      {!phone ? <span className="marker__label">{label}</span> : null}
    </>
  );
  // The ledger beside the map is the accessible control; markers are pointer shortcuts.
  if (state === 'town') {
    return (
      <a className={cls} style={style} href={routeHref('hub')} tabIndex={-1} aria-hidden="true">
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={style}
      onClick={onSelect}
      tabIndex={-1}
      aria-hidden="true"
    >
      {inner}
    </button>
  );
}

export function MapScreen() {
  const phone = useMediaQuery(PHONE_QUERY);
  const { world, activity, areaId, farmBusy, farmError, startFarming, reload } = useGame();
  const [ref, width] = useElementWidth<HTMLDivElement>(768);
  const current = activity.kind === 'ready' ? (activity.value?.areaId ?? null) : null;
  const pending = activity.kind === 'ready' ? (activity.value?.pendingAreaId ?? null) : null;
  const all = places(world.kind === 'ready' ? world.value : null, current, pending);
  const [selectedId, setSelectedId] = useState<PlaceId>(areaId);
  const selected = all.find((p) => p.id === selectedId) ?? all[0]!;

  // Side by side (wide screens) the map gets what the ledger leaves; stacked, the full width.
  const sideBySide = useMediaQuery(WIDE_QUERY);
  const room = sideBySide ? width - LEDGER_WIDTH - GAP : width;
  const scale = pixelScale(room, MAP.width, { min: 1, max: 3 });
  const stageWidth = Math.min(Math.floor(room), MAP.width * scale);
  const left = Math.round((stageWidth - MAP.width * scale) / 2);

  const go = async (id: AreaId) => {
    // A failure is shown from farmError; on success, follow the hero.
    if (await startFarming(id)) window.location.assign(routeHref('area'));
  };

  let action;
  if (selected.state === 'current') {
    action = (
      <a className="btn" href={routeHref('area')}>
        Watch the fight
      </a>
    );
  } else if (selected.state === 'next') {
    action = current ? (
      <button
        type="button"
        className="btn"
        disabled={farmBusy}
        aria-busy={farmBusy}
        onClick={() => void startFarming(current)}
      >
        Stay in {getArea(current).name}
      </button>
    ) : null;
  } else if (selected.state === 'open' && selected.kind === 'area') {
    const id = selected.id as AreaId;
    action = (
      <button
        type="button"
        className="btn btn--brass"
        disabled={farmBusy}
        aria-busy={farmBusy}
        onClick={() => void go(id)}
      >
        {farmBusy
          ? 'Setting out…'
          : current
            ? `Travel to ${selected.name}`
            : `Farm ${selected.name}`}
      </button>
    );
  } else if (selected.state === 'open' && selected.kind === 'dungeon') {
    const words = DUNGEON_WORDS[selected.id as DungeonId];
    action = (
      <a className="btn btn--brass" href={routeHref(words.route)}>
        {words.route === 'crypt' ? 'Go to the crypt door' : 'Go to the watchtower'}
      </a>
    );
  } else if (selected.state === 'sealed' && selected.blockers.some((b) => b.kind === 'worldFlag')) {
    // Ticket 4.8: the town opens it together (community projects, `#/works`).
    const others = selected.blockers.filter((b) => b.kind !== 'worldFlag');
    action = (
      <>
        <p className="ledger__why ledger__why--sealed">
          {selected.blockers
            .filter((b) => b.kind === 'worldFlag')
            .map((b) => blockerText(b))
            .join(' ')}{' '}
          Every hero in Graumark can help.
        </p>
        {others.length > 0 ? (
          <ul className="ledger__why" aria-label="Also needed to enter">
            {others.map((b) => (
              <li key={b.kind}>{blockerText(b)}</li>
            ))}
          </ul>
        ) : null}
        <a className="btn btn--brass" href={routeHref('works')}>
          See the town works
        </a>
      </>
    );
  } else if (selected.state === 'sealed') {
    action = <p className="ledger__why">The crypt door is sealed for now. Delving comes later.</p>;
  } else if (selected.state === 'locked') {
    action = (
      <ul className="ledger__why" aria-label="Needed to enter">
        {selected.blockers.map((b) => (
          <li key={b.kind}>{blockerText(b)}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="map">
      <header className="map__head">
        <Trail
          className="map__region"
          steps={[{ label: 'Town', route: 'hub' }, { label: 'World map' }]}
        />
        <h1 className="display map__title">World Map</h1>
        {pending && current ? (
          <p className="map__travel" role="status">
            Finishing the fight in {getArea(current).name}, then travelling to{' '}
            <strong>{getArea(pending).name}</strong>.
          </p>
        ) : null}
      </header>

      <div
        className="map__grid"
        ref={ref}
        style={
          sideBySide
            ? { gridTemplateColumns: `${stageWidth}px minmax(${LEDGER_WIDTH}px, 1fr)` }
            : undefined
        }
      >
        <div className="map__frame">
          <div
            className="map__stage"
            style={{ width: stageWidth || undefined, height: MAP.height * scale }}
          >
            <PixelSprite sprite={MAP} scale={scale} alt="" className="map__art" style={{ left }} />
            <Marker
              id="hub"
              label="Graumark"
              state="town"
              selected={false}
              scale={scale}
              left={left}
              phone={phone}
              onSelect={() => undefined}
            />
            {all.map((p) => (
              <Marker
                key={p.id}
                id={p.id}
                label={p.name}
                state={p.state}
                selected={p.id === selected.id}
                scale={scale}
                left={left}
                phone={phone}
                onSelect={() => setSelectedId(p.id)}
              />
            ))}
          </div>
        </div>

        <section className="ledger panel-iron" aria-labelledby="ledger-title">
          <h2 id="ledger-title" className="rule-heading">
            Places of Graumark
          </h2>
          {world.kind === 'loading' ? (
            <p className="ledger__note" role="status">
              Unrolling the map…
            </p>
          ) : null}
          {world.kind === 'error' ? (
            <div className="ledger__alert" role="alert">
              <p>{world.message}</p>
              <button type="button" className="btn" onClick={reload}>
                Try again
              </button>
            </div>
          ) : null}
          <ul className="ledger__list">
            {all.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`ledger__row ledger__row--${p.state}`}
                  aria-pressed={p.id === selected.id}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="ledger__name">{p.name}</span>
                  <span className="ledger__levels">Lv {p.levels}</span>
                  <span className={`ledger__state ledger__state--${p.state} caps`}>
                    {STATE_LABEL[p.state]}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="ledger__detail" aria-live="polite">
            <h3 className="display ledger__title">{selected.name}</h3>
            <p className="ledger__desc">{selected.description}</p>
            <p className="ledger__foes">
              <span className="caps">Foes</span> {selected.foes.join(', ')}
            </p>
            <div className="ledger__action">{action}</div>
            {farmError ? (
              <p className="ledger__alert" role="alert">
                {farmError}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
