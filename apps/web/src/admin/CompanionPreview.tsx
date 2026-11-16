import { PixelSprite } from '../components/PixelSprite';
import { COMPANION_IDS, asset, companionSprite, litShrine } from '../content/assets';

/** `companion.grave-moth` → `grave moth`, for the card's label. */
const words = (id: string) => id.slice('companion.'.length).replace(/-/g, ' ');

/**
 * Ticket A.19: the gallery's "Companions" section. Each Shrine companion's two-frame idle, played
 * (the gallery's Play and Idle breath switches drive it) and laid out frame by frame, next to the
 * lit Summoning Shrine over the hub's cold one. Art only: ticket 9.5 owns the companions as
 * cosmetics and draws them beside the hero.
 */
export function CompanionPreview({ scale }: { scale: number }) {
  const shrine = litShrine();
  const hub = asset('hub.graumark');
  return (
    <section className="anim-gallery__group" aria-label="Companions">
      <h2 className="rule-heading anim-gallery__title">
        Companions{' '}
        <span className="anim-gallery__note">
          the Reward Shrine&rsquo;s companions, a two-frame idle each, facing the foes; and the lit
          shrine on the hub
        </span>
      </h2>
      <ul className="anim-gallery__cards">
        {COMPANION_IDS.map((id) => {
          const sprite = companionSprite(id);
          return (
            <li key={id} className="anim-gallery__card anim-gallery__companion">
              {sprite ? (
                <>
                  <span className="anim-gallery__companion-idle">
                    <PixelSprite sprite={sprite} scale={scale} alt={`${words(id)}, idle`} />
                  </span>
                  <PixelSprite
                    sprite={{ path: sprite.path, width: sprite.width * 2, height: sprite.height }}
                    scale={1}
                    alt={`${words(id)}, both frames`}
                  />
                </>
              ) : (
                <span className="anim-gallery__missing">No art</span>
              )}
              <code>{id}</code>
            </li>
          );
        })}
        <li className="anim-gallery__card anim-gallery__companion">
          <span
            className="anim-gallery__shrine"
            style={{ width: shrine.width * scale, height: shrine.height * scale }}
          >
            <PixelSprite
              sprite={hub}
              scale={scale}
              alt=""
              style={{ marginLeft: -shrine.x * scale, marginTop: -shrine.y * scale }}
            />
          </span>
          <PixelSprite sprite={shrine} scale={scale} alt="The Summoning Shrine, lit" />
          <code>hub.shrine</code>
        </li>
      </ul>
    </section>
  );
}
