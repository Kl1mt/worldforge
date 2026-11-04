import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref } from './route';

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
