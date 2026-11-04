import { asset } from '../content/assets';
import { HUB_HOTSPOTS, type BuildingId } from '../content/world';
import { useMediaQuery } from '../components/useMediaQuery';
import { PHONE_QUERY } from '../lib/pixel';
import { routeHref } from '../lib/route';
import './hub.css';

const HUB = asset('hub.graumark');

/** The town buildings that have a screen in Phase 2 but no service yet. */
export type OpenBuildingId = Extract<BuildingId, 'tavern' | 'forge' | 'merchant'>;

const COPY: Record<OpenBuildingId, { title: string; text: string }> = {
  tavern: {
    title: 'The Tavern',
    text: 'The keeper is still chalking up the notice board. Quests and contracts will be posted here soon.',
  },
  forge: {
    title: 'The Forge',
    text: 'The fire is banked and the anvil cold. Salvaging and crafting will be done here soon.',
  },
  merchant: {
    title: 'The Merchant',
    text: 'The stall is shuttered while the wagons are on the road. Buying and selling will open here soon.',
  },
};

/** Placeholder screen for a hub building whose service arrives with a later ticket. */
export function BuildingScreen({ building }: { building: OpenBuildingId }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const spot = HUB_HOTSPOTS.find((h) => h.id === building)!;
  const copy = COPY[building];
  // The building cut from the town picture at an integer scale: ×4 on desktop, ×3 on phones.
  const scale = phone ? 3 : 4;
  return (
    <section className="building" aria-labelledby="building-title">
      <figure className="building__niche">
        <span
          className="building__art"
          role="img"
          aria-label={`${copy.title}, seen from the street`}
          style={{
            width: spot.width * scale,
            height: spot.height * scale,
            backgroundImage: `url(${HUB.path})`,
            backgroundSize: `${HUB.width * scale}px ${HUB.height * scale}px`,
            backgroundPosition: `${-spot.x * scale}px ${-spot.y * scale}px`,
          }}
        />
        <figcaption className="building__plaque">{spot.label}</figcaption>
      </figure>
      <div>
        <p className="caps building__soon">Graumark · Coming soon</p>
        <h1 id="building-title" className="display building__title">
          {copy.title}
        </h1>
        <p className="building__text">{copy.text}</p>
        <div className="building__actions">
          <a className="btn btn--brass" href={routeHref('hub')}>
            Back to town
          </a>
          <a className="btn" href={routeHref('map')}>
            World map
          </a>
        </div>
      </div>
    </section>
  );
}
