import { describe, expect, it } from 'vitest';
import { AUTH_ROUTES, GAME_ROUTES, guardRoute, parseRoute, routeHref } from './route';

describe('parseRoute', () => {
  it('parses known routes', () => {
    expect(parseRoute('#/character')).toBe('character');
    expect(parseRoute('#inventory')).toBe('inventory');
    expect(parseRoute('#/area/extra?x=1')).toBe('area');
    expect(parseRoute('#/characters')).toBe('characters');
  });

  it('falls back to the area screen', () => {
    expect(parseRoute('')).toBe('area');
    expect(parseRoute('#/forge')).toBe('area');
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
    for (const r of AUTH_ROUTES) expect(guardRoute(r, 'playing')).toBe('area');
  });
});
