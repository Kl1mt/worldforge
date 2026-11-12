import { isStaff, type AccountRole } from '@worldforge/game-core';

/** Game screens; they need a logged-in account with an active character. */
export const GAME_ROUTES = [
  'hub',
  'map',
  'area',
  'crypt',
  // Ticket 4.8: the Warden's Watch (the Ashen Pass's boss).
  'watch',
  // Ticket 6.2: the Tyrant's Forge (the Cinderwastes' region boss). `forge` is the town's Forge.
  'tyrant',
  // Ticket 8.2: the Hollow Throne (the Hollow Reach's region boss).
  'throne',
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
  // Ticket 5.2: the leaderboards, `#/boards/<metric>?class=<classId>&bracket=<id>`.
  'boards',
  // Ticket F.3: the patch notes ("What's new"), `#/notes`.
  'notes',
  // Ticket 5.5: the arena, `#/arena`, `#/arena/duel/<id>` (a duel's result) or
  // `#/arena/friendly/<handle>` (a friend to challenge).
  'arena',
  // Ticket T.5: trade offers, `#/trading` (says plainly that trading is closed until it opens).
  'trading',
  // Ticket 6.8: the collection book, `#/collection` (cosmetics: earned, locked, equip).
  'collection',
] as const;
/** The gate: only shown to visitors without a session. Ticket 5.7: `forgot` (password). */
export const AUTH_ROUTES = ['login', 'register', 'forgot'] as const;
/**
 * Ticket 5.7: the links in mails, `#/verify?token=…` and `#/reset?token=…`. Open to everyone,
 * logged in or not (a letter may be opened on another device).
 */
export const TOKEN_ROUTES = ['verify', 'reset'] as const;
/** Character select and creation: needs an account, but not an active character. */
export const ROSTER_ROUTE = 'characters' as const;
/** Ticket D.2: Impressum and privacy policy, open to everyone, logged in or not. */
export const LEGAL_ROUTES = ['impressum', 'datenschutz'] as const;
export const ROUTES = [
  ...GAME_ROUTES,
  ...AUTH_ROUTES,
  ROSTER_ROUTE,
  ...LEGAL_ROUTES,
  ...TOKEN_ROUTES,
] as const;

export type GameRoute = (typeof GAME_ROUTES)[number];
export type AuthRoute = (typeof AUTH_ROUTES)[number];
export type LegalRoute = (typeof LEGAL_ROUTES)[number];
export type TokenRoute = (typeof TOKEN_ROUTES)[number];
export type Route = (typeof ROUTES)[number];

export function isTokenRoute(route: Route): route is TokenRoute {
  return (TOKEN_ROUTES as readonly string[]).includes(route);
}

/** Ticket 5.7: the `token` of `#/verify?token=…` / `#/reset?token=…` (shape checked), or null. */
export function tokenFromHash(hash: string): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const token = new URLSearchParams(hash.slice(q + 1)).get('token');
  return token && /^[A-Za-z0-9_-]{20,128}$/.test(token) ? token : null;
}

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
export const ADMIN_SECTIONS = [
  // Ticket 8.6: the going-live readiness board (docs/GOING_LIVE.md).
  'readiness',
  'invites',
  'players',
  // Ticket D.4: the account inspector (`#/admin/inspect/<handle>`) and the world flags/scheduler.
  'inspect',
  'world',
  'telemetry',
  'seasons',
  // Ticket 6.6: the event calendar (schedule, extend, end early, cancel a future one).
  'events',
  'trading',
  // Ticket T.6: the trade ledger, case view, reversal and pattern report.
  'trades',
  'status',
  'roles',
  // Ticket 6.9: reserved names (staff, bosses, the town's people, and the admins' own).
  'names',
  // Ticket A.14c: every sprite's animations and a scene preview (assets only).
  'animations',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/**
 * Tickets 4.1 / D.3 (A.14c made it testable): routes that behave like an unknown address for this
 * viewer. The moderator queue exists for staff only, the admin panel (every section, the A.14c
 * animation gallery included) for admins only. `role` is null when nobody is logged in.
 */
export function routeHiddenFor(route: Route, role: AccountRole | null): boolean {
  const staff = role !== null && isStaff(role);
  return (route === 'moderation' && !staff) || (route === 'admin' && role !== 'admin');
}

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
  if (isLegalRoute(route) || isTokenRoute(route)) return null;
  if (standing === 'anonymous') return isAuthRoute(route) ? null : LOGIN_ROUTE;
  if (standing === 'account') return route === ROSTER_ROUTE ? null : ROSTER_ROUTE;
  return isAuthRoute(route) ? DEFAULT_ROUTE : null;
}

/** Ticket 5.2: a board's address (metric, class filter, level bracket; 5.3: the season). */
export interface BoardLocation {
  metric: string | null;
  classId: string | null;
  bracket: string | null;
  /** Ticket 5.3: null = all time; `current` = the season under way (or the latest); else its number. */
  season: 'current' | number | null;
}

/** `#/boards/power?class=mage&bracket=20-29&season=2` → its parts (only the shape is checked). */
export function boardLocation(hash: string): BoardLocation {
  const m = /^#\/?boards(?:\/([a-zA-Z]{1,32}))?(?:\?(.*))?$/.exec(hash);
  const q = new URLSearchParams(m?.[2] ?? '');
  const ok = (v: string | null) => (v && /^[0-9a-z-]{1,32}$/i.test(v) ? v : null);
  const s = q.get('season');
  const season = s === 'current' ? 'current' : s && /^[1-9]\d{0,5}$/.test(s) ? Number(s) : null;
  return {
    metric: m?.[1] ?? null,
    classId: ok(q.get('class')),
    bracket: ok(q.get('bracket')),
    season,
  };
}

export function boardHref(
  metric: string,
  {
    classId,
    bracket,
    season,
  }: { classId?: string | null; bracket?: string | null; season?: 'current' | number | null } = {},
): string {
  const q = new URLSearchParams();
  if (classId) q.set('class', classId);
  if (bracket) q.set('bracket', bracket);
  if (season) q.set('season', String(season));
  const qs = q.toString();
  return `#/boards/${encodeURIComponent(metric)}${qs ? `?${qs}` : ''}`;
}

/** Ticket 5.5: the duel id in `#/arena/duel/<id>`, if any (only the shape is checked). */
export function arenaDuelFromHash(hash: string): string | null {
  const m = /^#\/?arena\/duel\/([0-9a-f-]{36})(?:[/?]|$)/i.exec(hash);
  return m ? m[1]!.toLowerCase() : null;
}

/** Ticket 5.5: the friend's handle in `#/arena/friendly/<handle>`, if any. */
export function arenaFriendFromHash(hash: string): string | null {
  const m = /^#\/?arena\/friendly\/([0-9a-z]{1,64})(?:[/?]|$)/i.exec(hash);
  return m ? m[1]!.toLowerCase() : null;
}

/** The arena; with a duel, its result; with a friend's handle, their friendly challenge. */
export function arenaHref(to: { duel?: string; friend?: string } = {}): string {
  if (to.duel) return `#/arena/duel/${encodeURIComponent(to.duel)}`;
  if (to.friend) return `#/arena/friendly/${encodeURIComponent(to.friend)}`;
  return routeHref('arena');
}
