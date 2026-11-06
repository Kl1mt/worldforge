/** Game screens; they need a logged-in account with an active character. */
export const GAME_ROUTES = [
  'hub',
  'map',
  'area',
  'crypt',
  'character',
  'inventory',
  'tavern',
  'forge',
  'merchant',
  // Ticket 4.1: account standing (sanctions, reports) and the moderator queue (staff only; for
  // everyone else it behaves like an unknown address).
  'account',
  'moderation',
  // Ticket 4.3: friends, requests, blocks and presence.
  'friends',
] as const;
/** The gate: only shown to visitors without a session. */
export const AUTH_ROUTES = ['login', 'register'] as const;
/** Character select and creation: needs an account, but not an active character. */
export const ROSTER_ROUTE = 'characters' as const;
/** Ticket D.2: Impressum and privacy policy, open to everyone, logged in or not. */
export const LEGAL_ROUTES = ['impressum', 'datenschutz'] as const;
export const ROUTES = [...GAME_ROUTES, ...AUTH_ROUTES, ROSTER_ROUTE, ...LEGAL_ROUTES] as const;

export type GameRoute = (typeof GAME_ROUTES)[number];
export type AuthRoute = (typeof AUTH_ROUTES)[number];
export type LegalRoute = (typeof LEGAL_ROUTES)[number];
export type Route = (typeof ROUTES)[number];

/** The hub is home (ticket 2.2). */
export const DEFAULT_ROUTE: GameRoute = 'hub';
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

export function isAuthRoute(route: Route): route is AuthRoute {
  return (AUTH_ROUTES as readonly string[]).includes(route);
}

export function isLegalRoute(route: Route): route is LegalRoute {
  return (LEGAL_ROUTES as readonly string[]).includes(route);
}

/**
 * Ticket D.2: the invite code of an invite link, from `#/register?invite=CODE` (what the admin
 * CLI prints) or `/?invite=CODE`. Only the shape is checked here; the server decides.
 */
export function inviteFromLocation(search: string, hash: string): string | null {
  const fromHash = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
  for (const query of [fromHash, search]) {
    const code = new URLSearchParams(query).get('invite')?.trim();
    if (code && code.length <= 64) return code;
  }
  return null;
}

/** The register screen with an invite code prefilled. */
export function registerHref(invite: string | null): string {
  return invite
    ? `${routeHref('register')}?invite=${encodeURIComponent(invite)}`
    : routeHref('register');
}

/**
 * How far into the game the visitor is: logged out, logged in without an active character,
 * or playing a character.
 */
export type Standing = 'anonymous' | 'account' | 'playing';

/**
 * Route guard: where a visitor with this standing should be sent, or `null` to stay.
 * Logged-out visitors go to the login gate; logged-in players skip the gate and, until they
 * have an active character, land on character select.
 */
export function guardRoute(route: Route, standing: Standing): Route | null {
  if (isLegalRoute(route)) return null;
  if (standing === 'anonymous') return isAuthRoute(route) ? null : LOGIN_ROUTE;
  if (standing === 'account') return route === ROSTER_ROUTE ? null : ROSTER_ROUTE;
  return isAuthRoute(route) ? DEFAULT_ROUTE : null;
}
