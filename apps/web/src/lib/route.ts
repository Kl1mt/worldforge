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
  // Ticket 4.2: public profiles, `#/profile` (your own) or `#/profile/<handle>`.
  'profile',
  // Ticket 4.3: friends, requests, blocks and presence.
  'friends',
  // Ticket D.3: the admin panel, `#/admin/<section>` (admins only; for everyone else it behaves
  // like an unknown address).
  'admin',
  // Ticket 4.4: the Guild Hall, `#/guild` (your guild, or found/join one) or `#/guild/<handle>`.
  'guild',
  // Ticket 4.6: the town works (community projects), `#/works`.
  'works',
  // Ticket 4.7: the Warehouse, `#/warehouse` (per-character storage; shown locked until restored).
  'warehouse',
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

/** Ticket 4.2: the handle in `#/profile/<handle>`, if any (only the shape is checked). */
export function profileHandleFromHash(hash: string): string | null {
  const m = /^#\/?profile\/([0-9a-z]{1,64})(?:[/?]|$)/i.exec(hash);
  return m ? m[1]!.toLowerCase() : null;
}

/** The profile page of a handle; without one, your own. */
export function profileHref(handle?: string): string {
  return handle ? `#/profile/${encodeURIComponent(handle)}` : routeHref('profile');
}

/** Ticket D.3: the admin panel's sections, in tab order. */
export const ADMIN_SECTIONS = ['invites', 'players', 'telemetry', 'status', 'roles'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** `#/admin/players/<handle>` → `{ section: 'players', arg: '<handle>' }`; default: invites. */
export function adminLocation(hash: string): { section: AdminSection; arg: string | null } {
  const m = /^#\/?admin(?:\/([a-z]+))?(?:\/([0-9a-z]{1,64}))?(?:[/?]|$)/i.exec(hash);
  const section = (ADMIN_SECTIONS as readonly string[]).includes(m?.[1] ?? '')
    ? (m![1] as AdminSection)
    : 'invites';
  return { section, arg: m?.[2]?.toLowerCase() ?? null };
}

export function adminHref(section: AdminSection, arg?: string): string {
  return `#/admin/${section}${arg ? `/${encodeURIComponent(arg)}` : ''}`;
}

/** Ticket D.3: the moderator queue opened on the case holding this report. */
export function moderationCaseHref(reportId: string): string {
  return `${routeHref('moderation')}?case=${encodeURIComponent(reportId)}`;
}

/** The report id of `#/moderation?case=<id>`, if any. */
export function moderationCaseFromHash(hash: string): string | null {
  if (!/^#\/?moderation\?/.test(hash)) return null;
  const id = new URLSearchParams(hash.slice(hash.indexOf('?'))).get('case');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
}

/** Ticket 4.4: the guild handle in `#/guild/<handle>`, if any (only the shape is checked). */
export function guildHandleFromHash(hash: string): string | null {
  const m = /^#\/?guild\/([0-9a-z]{1,64})(?:[/?]|$)/i.exec(hash);
  return m ? m[1]!.toLowerCase() : null;
}

/** A guild's public profile; without a handle, the Guild Hall (your own guild). */
export function guildHref(handle?: string): string {
  return handle ? `#/guild/${encodeURIComponent(handle)}` : routeHref('guild');
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
