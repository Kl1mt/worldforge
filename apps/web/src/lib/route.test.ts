import { describe, expect, it } from 'vitest';
import {
  adminHref,
  adminLocation,
  moderationCaseFromHash,
  moderationCaseHref,
  AUTH_ROUTES,
  GAME_ROUTES,
  LEGAL_ROUTES,
  guardRoute,
  inviteFromLocation,
  parseRoute,
  boardHref,
  boardLocation,
  profileHandleFromHash,
  profileHref,
  registerHref,
  routeHref,
} from './route';

describe('parseRoute', () => {
  it('parses known routes', () => {
    expect(parseRoute('#/character')).toBe('character');
    expect(parseRoute('#inventory')).toBe('inventory');
    expect(parseRoute('#/area/extra?x=1')).toBe('area');
    expect(parseRoute('#/characters')).toBe('characters');
  });

  it('falls back to the hub', () => {
    expect(parseRoute('')).toBe('hub');
    expect(parseRoute('#/smithy')).toBe('hub');
  });

  it('parses the hub, the map and the buildings', () => {
    for (const r of ['hub', 'map', 'tavern', 'forge', 'merchant'] as const) {
      expect(parseRoute(routeHref(r))).toBe(r);
    }
  });

  it('round-trips through routeHref', () => {
    expect(parseRoute(routeHref('inventory'))).toBe('inventory');
  });

  it('parses the gate routes', () => {
    expect(parseRoute('#/login')).toBe('login');
    expect(parseRoute('#/register')).toBe('register');
  });
});

describe('guardRoute', () => {
  it('sends logged-out visitors from game screens and character select to the login gate', () => {
    for (const r of GAME_ROUTES) expect(guardRoute(r, 'anonymous')).toBe('login');
    expect(guardRoute('characters', 'anonymous')).toBe('login');
    for (const r of AUTH_ROUTES) expect(guardRoute(r, 'anonymous')).toBeNull();
  });

  it('sends logged-in players without an active character to character select', () => {
    for (const r of [...GAME_ROUTES, ...AUTH_ROUTES]) {
      expect(guardRoute(r, 'account')).toBe('characters');
    }
    expect(guardRoute('characters', 'account')).toBeNull();
  });

  it('lets players with a character into the game and back to character select', () => {
    for (const r of GAME_ROUTES) expect(guardRoute(r, 'playing')).toBeNull();
    expect(guardRoute('characters', 'playing')).toBeNull();
    for (const r of AUTH_ROUTES) expect(guardRoute(r, 'playing')).toBe('hub');
  });
});

describe('legal pages and invite links (ticket D.2)', () => {
  it('parses the legal routes and never guards them', () => {
    for (const r of LEGAL_ROUTES) {
      expect(parseRoute(routeHref(r))).toBe(r);
      for (const standing of ['anonymous', 'account', 'playing'] as const) {
        expect(guardRoute(r, standing)).toBeNull();
      }
    }
  });

  it('reads the invite code from the hash or the query', () => {
    expect(inviteFromLocation('', '#/register?invite=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(inviteFromLocation('?invite=WXYZ', '')).toBe('WXYZ');
    expect(inviteFromLocation('?invite=FROM-QUERY', '#/register?invite=FROM-HASH')).toBe(
      'FROM-HASH',
    );
    expect(inviteFromLocation('', '#/register')).toBeNull();
    expect(inviteFromLocation('?invite=', '')).toBeNull();
    expect(inviteFromLocation(`?invite=${'x'.repeat(65)}`, '')).toBeNull();
  });

  it('builds a register link that keeps the code and still parses as register', () => {
    const href = registerHref('AB CD');
    expect(href).toBe('#/register?invite=AB%20CD');
    expect(parseRoute(href)).toBe('register');
    expect(inviteFromLocation('', href)).toBe('AB CD');
    expect(registerHref(null)).toBe('#/register');
  });
});

describe('profile links (ticket 4.2)', () => {
  it('parses the handle of a profile link', () => {
    expect(parseRoute('#/profile/abc123def456')).toBe('profile');
    expect(parseRoute('#/profile')).toBe('profile');
    expect(profileHandleFromHash('#/profile/ABC123def456')).toBe('abc123def456');
    expect(profileHandleFromHash('#/profile/abc123def456?x=1')).toBe('abc123def456');
    expect(profileHandleFromHash('#/profile')).toBeNull();
    expect(profileHandleFromHash('#/profile/<script>')).toBeNull();
    expect(profileHandleFromHash('#/hub')).toBeNull();
  });

  it('builds profile links', () => {
    expect(profileHref()).toBe('#/profile');
    expect(profileHref('abc123def456')).toBe('#/profile/abc123def456');
  });
});

describe('admin panel links (ticket D.3)', () => {
  it('parses the section and its argument', () => {
    expect(parseRoute('#/admin')).toBe('admin');
    expect(parseRoute('#/admin/players/abc')).toBe('admin');
    expect(adminLocation('#/admin')).toEqual({ section: 'invites', arg: null });
    expect(adminLocation('#/admin/status')).toEqual({ section: 'status', arg: null });
    expect(adminLocation('#/admin/players/ABCDEFGHJKMN')).toEqual({
      section: 'players',
      arg: 'abcdefghjkmn',
    });
    expect(adminLocation('#/admin/nonsense')).toEqual({ section: 'invites', arg: null });
    expect(adminHref('players', 'abc')).toBe('#/admin/players/abc');
    expect(adminHref('roles')).toBe('#/admin/roles');
  });

  it('links into a moderator-queue case', () => {
    const id = '0190a0b0-0000-7000-8000-000000000001';
    expect(moderationCaseHref(id)).toBe(`#/moderation?case=${id}`);
    expect(parseRoute(moderationCaseHref(id))).toBe('moderation');
    expect(moderationCaseFromHash(moderationCaseHref(id))).toBe(id);
    expect(moderationCaseFromHash('#/moderation')).toBeNull();
    expect(moderationCaseFromHash('#/moderation?case=<x>')).toBeNull();
  });
});

describe('board locations (ticket 5.2)', () => {
  it('round-trips metric and filters', () => {
    const href = boardHref('power', { classId: 'mage', bracket: '20-29' });
    expect(href).toBe('#/boards/power?class=mage&bracket=20-29');
    expect(boardLocation(href)).toEqual({
      metric: 'power',
      classId: 'mage',
      bracket: '20-29',
      season: null,
    });
    expect(parseRoute(href)).toBe('boards');
  });
  it('round-trips the season (ticket 5.3)', () => {
    expect(boardLocation(boardHref('level', { season: 3 })).season).toBe(3);
    expect(boardLocation(boardHref('level', { season: 'current' })).season).toBe('current');
    expect(boardHref('level', { season: null })).toBe('#/boards/level');
  });
  it('ignores what is not shaped like a filter', () => {
    expect(boardLocation('#/boards')).toEqual({
      metric: null,
      classId: null,
      bracket: null,
      season: null,
    });
    expect(boardLocation('#/boards/level?class=%3Cscript%3E').classId).toBeNull();
    expect(boardLocation('#/boards/level?season=0').season).toBeNull();
    expect(boardLocation('#/boards/level?season=-1').season).toBeNull();
  });
});
