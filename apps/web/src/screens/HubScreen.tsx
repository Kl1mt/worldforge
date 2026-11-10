import { useState, type ReactNode } from 'react';
import { getArea } from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { asset } from '../content/assets';
import { HUB_HOTSPOTS, type BuildingId, type Hotspot } from '../content/world';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { useMediaQuery } from '../components/useMediaQuery';
import { useGame } from '../game/GameProvider';
import { PHONE_QUERY, pixelScale } from '../lib/pixel';
import { routeHref, type GameRoute } from '../lib/route';
import { Meter } from '../components/Meter';
import { EventBanner } from '../events/EventBanner';
import { projectProgress, useProjectBoard, type BoardState } from '../community/api';
import { useOnboarding } from '../onboarding/OnboardingProvider';
import './hub.css';
import './works.css';
import './arena.css';

const HUB = asset('hub.graumark');

interface Building {
  /** Where it leads; null = not built yet in this phase ("later"). */
  route: GameRoute | null;
  /** What it is for, one line (GDD §4.2). */
  purpose: string;
}

/** The hub's buildings (GDD §4.2). Order follows the street from left to right. */
const BUILDINGS: Record<BuildingId, Building> = {
  worldMap: { route: 'map', purpose: 'Choose where your hero fights.' },
  forge: { route: 'forge', purpose: 'Salvage and craft gear.' },
  merchant: { route: 'merchant', purpose: 'Buy and sell goods.' },
  tavern: { route: 'tavern', purpose: 'Quests, contracts and notices.' },
  guildHall: { route: 'guild', purpose: 'Found a guild, or find one to join.' },
  warehouse: { route: null, purpose: 'Storage, once the town mends the doors (Town works).' },
  summoningShrine: { route: null, purpose: 'The shrine is cold for now.' },
};

/** Hotspots in reading order for keyboards and the signpost: the map table first. */
const ORDERED: Hotspot[] = [
  ...HUB_HOTSPOTS.filter((h) => h.id === 'worldMap'),
  ...HUB_HOTSPOTS.filter((h) => h.id !== 'worldMap'),
];

/** Ticket 4.7: the Warehouse once the town has restored it (world flag `warehouseRestored`). */
const OPEN_WAREHOUSE: Building = {
  route: 'warehouse',
  purpose: 'Store what you keep: safe from the filter, no room in the pack.',
};

/** Ticket 4.7: the Warehouse is built but locked (a world flag), not "later". */
const lockedWord = (id: BuildingId) => (id === 'warehouse' ? 'locked' : 'later');

function accessibleLabel(h: Hotspot, buildings: Record<BuildingId, Building>): string {
  const b = buildings[h.id];
  if (b.route) return `${h.label}: ${b.purpose}`;
  return h.id === 'warehouse'
    ? `${h.label}, locked until the town restores it. ${b.purpose}`
    : `${h.label}, opens later. ${b.purpose}`;
}

/**
 * Ticket 4.6: the town works slip under the picture — the community project under way (or the
 * last one finished), with the town's progress and a link to the board.
 */
function WorksSlip({ state }: { state: BoardState }) {
  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <p className="works-slip panel-ledger works-slip__meta">
        The works ledger cannot be read right now. <a href={routeHref('works')}>Town works</a>
      </p>
    );
  }
  const projects = state.board.projects;
  const open = projects.find((p) => p.status === 'open');
  const shown = open ?? projects.filter((p) => p.status === 'complete').at(-1);
  if (!shown) return null;
  const pct = Math.round(projectProgress(shown) * 100);
  const stage = shown.stages[shown.stageIndex];
  return (
    <section className="works-slip panel-ledger" aria-label="Town works">
      <div>
        <p className="caps works__eyebrow">Town works</p>
        <p className="works-slip__title">{shown.name}</p>
        <p className="works-slip__meta">
          {shown.status === 'complete'
            ? `Finished on ${shown.completedOn}.`
            : `${pct} % · now: ${stage?.name ?? ''} (stage ${shown.stageIndex + 1} of ${shown.stages.length}). Every hero may give a share a day.`}
        </p>
      </div>
      <a className="btn btn--small" href={routeHref('works')}>
        {shown.status === 'complete' ? 'See the works' : 'Lend a hand'}
      </a>
      <Meter variant="xp" label={`${shown.name}: ${pct} % done`} current={pct} max={100} />
    </section>
  );
}

/** Ticket 5.5: the Proving Ring, the town's duel ground, beside the works slip. */
function ArenaSlip() {
  return (
    <section className="arena-slip panel-ledger" aria-label="The Proving Ring">
      <div>
        <p className="caps arena-slip__eyebrow">The Proving Ring</p>
        <p className="arena-slip__title">Duel saved heroes</p>
        <p className="arena-slip__meta">
          Rated duels from level 10, friendly challenges with friends and guildmates. A loss takes
          nothing from you.
        </p>
      </div>
      <a className="btn btn--small" href={routeHref('arena')}>
        Enter the arena
      </a>
    </section>
  );
}

function HeroWhereabouts() {
  const hero = useActiveCharacter();
  const { activity } = useGame();
  if (activity.kind === 'loading') return <p className="hub__where">Asking after {hero.name}…</p>;
  if (activity.kind === 'error') {
    return <p className="hub__where">No word from the road right now.</p>;
  }
  const a = activity.value;
  if (!a) {
    return (
      <p className="hub__where">
        {hero.name} rests in town. <a href={routeHref('map')}>Choose an area on the map</a>.
      </p>
    );
  }
  return (
    <p className="hub__where">
      <span className="hub__where-dot" aria-hidden="true" />
      {hero.name} is fighting in <a href={routeHref('area')}>{getArea(a.areaId).name}</a>
      {a.pendingAreaId ? <>, then travels to {getArea(a.pendingAreaId).name}</> : null}.
    </p>
  );
}

export function HubScreen() {
  const phone = useMediaQuery(PHONE_QUERY);
  const { state: works } = useProjectBoard();
  const { worldFlags } = useOnboarding();
  // The world flag is the source of truth (the server checks it on every warehouse route); the
  // board's finished project shows it as soon as the board arrives.
  const restored =
    worldFlags?.warehouseRestored === true ||
    (works.kind === 'ready' &&
      works.board.projects.some((p) => p.id === 'restoreWarehouse' && p.status === 'complete'));
  const buildings: Record<BuildingId, Building> = restored
    ? { ...BUILDINGS, warehouse: OPEN_WAREHOUSE }
    : BUILDINGS;
  const [ref, width] = useElementWidth<HTMLDivElement>(1152);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [focus, setFocus] = useState<BuildingId | null>(null);
  // Desktop: as large as fits (×2 or ×3). Phones: ×1, cropped around the centre if needed.
  const scale = pixelScale(width, HUB.width, { min: 1, max: 3 });
  const stageWidth = Math.min(Math.floor(width), HUB.width * scale);
  const left = Math.round((stageWidth - HUB.width * scale) / 2);
  const inscription = focus ? buildings[focus].purpose : null;

  const later = (h: Hotspot) =>
    setNotice(
      h.id === 'warehouse' ? (
        // Ticket 4.7: locked until the town restores it; point at the project board.
        <>
          The Warehouse is locked until the town restores it.{' '}
          <a href={routeHref('works')}>See the town works</a>.
        </>
      ) : (
        `The ${h.label} opens later. ${buildings[h.id].purpose}`
      ),
    );

  return (
    <div className="hub">
      <header className="hub__head">
        <p className="caps hub__region">Graumark · Frontier town</p>
        <h1 className="display hub__title">Graumark</h1>
        <HeroWhereabouts />
      </header>

      <EventBanner />

      <div className="hub__frame" ref={ref}>
        <div
          className="hub__stage"
          style={{ width: stageWidth || undefined, height: HUB.height * scale }}
          onMouseLeave={() => setFocus(null)}
        >
          <PixelSprite
            sprite={HUB}
            scale={scale}
            alt="The frontier town of Graumark at dusk: a forge, a merchant stall, a tavern, a guild hall, a warehouse, a small shrine and a map table by the road."
            className="hub__art"
            style={{ left }}
          />
          {ORDERED.map((h) => {
            const b = buildings[h.id];
            const cx = (h.x + h.width / 2) / HUB.width;
            const align = cx < 0.12 ? 'start' : cx > 0.88 ? 'end' : 'center';
            const style = {
              left: left + h.x * scale,
              top: h.y * scale,
              width: h.width * scale,
              height: h.height * scale,
            };
            const common = {
              className: `hotspot hotspot--${align}${b.route ? '' : ' hotspot--later'}`,
              style,
              'aria-label': accessibleLabel(h, buildings),
              onMouseEnter: () => setFocus(h.id),
              onFocus: () => setFocus(h.id),
              onBlur: () => setFocus(null),
              // Phones use the signpost below (large tap targets); the art stays decorative.
              ...(phone ? { tabIndex: -1, 'aria-hidden': true } : {}),
            };
            const plaque = (
              <span className="hotspot__plaque" aria-hidden="true">
                {h.label}
                {b.route ? null : <span className="hotspot__later">{lockedWord(h.id)}</span>}
              </span>
            );
            return b.route ? (
              <a key={h.id} href={routeHref(b.route)} {...common}>
                {plaque}
              </a>
            ) : (
              <button
                key={h.id}
                type="button"
                aria-disabled="true"
                onClick={() => later(h)}
                {...common}
              >
                {plaque}
              </button>
            );
          })}
        </div>
        {!phone ? (
          <p className="hub__inscription" aria-hidden="true">
            {inscription ?? 'Choose a building.'}
          </p>
        ) : null}
      </div>

      <p className="hub__notice" role="status">
        {notice}
      </p>

      <WorksSlip state={works} />
      <ArenaSlip />

      {phone ? (
        <nav className="signpost" aria-label="Buildings">
          <ul>
            {ORDERED.map((h) => {
              const b = buildings[h.id];
              const body = (
                <>
                  <span className="signpost__name display">{h.label}</span>
                  <span className="signpost__purpose">{b.purpose}</span>
                  {b.route ? null : (
                    <span className="signpost__later caps">{lockedWord(h.id)}</span>
                  )}
                </>
              );
              return (
                <li key={h.id}>
                  {b.route ? (
                    <a className="signpost__board" href={routeHref(b.route)}>
                      {body}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="signpost__board signpost__board--later"
                      aria-disabled="true"
                      aria-label={accessibleLabel(h, buildings)}
                      onClick={() => later(h)}
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
