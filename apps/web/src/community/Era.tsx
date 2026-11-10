import { eraCrierLine, worldEra, type WorldEraDefinition } from '@worldforge/game-core';
import { useOnboarding } from '../onboarding/OnboardingProvider';
import './era.css';

/**
 * Ticket 6.7: the world era in town (docs/WORLD.md "Eras of Graumark"). Derived from the world
 * flags of the 120 s world poll with game-core's `worldEra`, the same rule the server uses; words
 * and colour only. Until the first answer (loading) or after a failed poll there is no era to show,
 * so the town looks as it always did: no title, no tint, the Tavern's old line.
 */
export function useWorldEra(): WorldEraDefinition | null {
  const { worldFlags } = useOnboarding();
  return worldFlags ? worldEra(worldFlags) : null;
}

/** The small "Era of …" title in the town header. */
export function EraTitle({ era }: { era: WorldEraDefinition | null }) {
  if (!era) return null;
  return (
    <p className="hub-era__title" title={era.tagline}>
      <span className="hub-era__mark" aria-hidden="true" />
      {era.title}
    </p>
  );
}

/**
 * Over the town picture: the era's tint and light (CSS gradients, no new art) and its banners,
 * hung from the top edge. Decorative: the picture's alt text stays the description.
 */
export function EraOverlay({ era }: { era: WorldEraDefinition | null }) {
  if (!era) return null;
  return (
    <div className={`hub-era__overlay hub-era--${era.id}`} aria-hidden="true">
      <span className="hub-era__tint" />
      <span className="hub-era__banners">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="hub-era__banner" />
        ))}
      </span>
    </div>
  );
}

/** The town crier's call of the day (UTC, as the server's) and the banners' words. */
export function EraCrier({
  era,
  now = new Date(),
}: {
  era: WorldEraDefinition | null;
  now?: Date;
}) {
  if (!era) return null;
  return (
    <p className={`hub-era__crier hub-era--${era.id}`}>
      <span className="caps hub-era__crier-who">The town crier</span>{' '}
      <q>{eraCrierLine(era, now.toISOString().slice(0, 10))}</q>{' '}
      <span className="hub-era__crier-banner">{era.banner}</span>
    </p>
  );
}
