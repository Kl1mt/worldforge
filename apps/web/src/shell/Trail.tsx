import { routeHref, type GameRoute } from '../lib/route';

export interface TrailStep {
  label: string;
  /** Omitted for the current place (the last step). */
  route?: GameRoute;
}

/**
 * Where-you-are trail for the bigger world (ticket 2.7): Town › World map › the place. Each
 * step but the last links back, so hub ↔ map ↔ area is one tap either way.
 */
export function Trail({ steps, className }: { steps: TrailStep[]; className?: string }) {
  return (
    <nav className={`trail caps${className ? ` ${className}` : ''}`} aria-label="You are here">
      <ol>
        {steps.map((s, i) => (
          <li key={s.label}>
            {s.route && i < steps.length - 1 ? (
              <a href={routeHref(s.route)}>{s.label}</a>
            ) : (
              <span aria-current="page">{s.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
