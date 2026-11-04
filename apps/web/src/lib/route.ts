/** Game screens; they need a logged-in account. */
export const GAME_ROUTES = ['area', 'character', 'inventory'] as const;
/** The gate: only shown to visitors without a session. */
export const AUTH_ROUTES = ['login', 'register'] as const;
export const ROUTES = [...GAME_ROUTES, ...AUTH_ROUTES] as const;

export type GameRoute = (typeof GAME_ROUTES)[number];
export type AuthRoute = (typeof AUTH_ROUTES)[number];
export type Route = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: GameRoute = 'area';
export const LOGIN_ROUTE: AuthRoute = 'login';

/** Parses `#/character` style hashes. Unknown or empty hashes fall back to the default route. */
export function parseRoute(hash: string): Route {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (ROUTES as readonly string[]).includes(id) ? (id as Route) : DEFAULT_ROUTE;
}

export function routeHref(route: Route): string {
  return `#/${route}`;
}

export function isGameRoute(route: Route): route is GameRoute {
  return (GAME_ROUTES as readonly string[]).includes(route);
}

/**
 * Route guard: where a visitor in this auth state should be sent, or `null` to stay.
 * Logged-out visitors go to the login gate; logged-in players skip the gate.
 */
export function guardRoute(route: Route, signedIn: boolean): Route | null {
  if (!signedIn && isGameRoute(route)) return LOGIN_ROUTE;
  if (signedIn && !isGameRoute(route)) return DEFAULT_ROUTE;
  return null;
}
