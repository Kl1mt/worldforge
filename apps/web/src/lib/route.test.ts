import { describe, expect, it } from 'vitest';
import { GAME_ROUTES, guardRoute, parseRoute, routeHref } from './route';

describe('parseRoute', () => {
  it('parses known routes', () => {
    expect(parseRoute('#/character')).toBe('character');
    expect(parseRoute('#inventory')).toBe('inventory');
    expect(parseRoute('#/area/extra?x=1')).toBe('area');
  });

  it('falls back to the area screen', () => {
    expect(parseRoute('')).toBe('area');
    expect(parseRoute('#/forge')).toBe('area');
  });

  it('round-trips through routeHref', () => {
    expect(parseRoute(routeHref('inventory'))).toBe('inventory');
  });
});

describe('guardRoute', () => {
  it('sends logged-out visitors from game screens to the login gate', () => {
    for (const r of GAME_ROUTES) expect(guardRoute(r, false)).toBe('login');
    expect(guardRoute('login', false)).toBeNull();
    expect(guardRoute('register', false)).toBeNull();
  });

  it('sends logged-in players past the gate', () => {
    for (const r of GAME_ROUTES) expect(guardRoute(r, true)).toBeNull();
    expect(guardRoute('login', true)).toBe('area');
    expect(guardRoute('register', true)).toBe('area');
  });

  it('parses the gate routes', () => {
    expect(parseRoute('#/login')).toBe('login');
    expect(parseRoute('#/register')).toBe('register');
  });
});
