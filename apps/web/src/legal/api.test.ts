import { describe, expect, it } from 'vitest';
import { LEGAL_ROUTES, guardRoute, parseRoute, routeHref } from '../lib/route';
import { LEGAL_LINKS, LEGAL_TITLES, legalApi } from './api';

describe('legal links (ticket D.2)', () => {
  it('link every legal page, reachable without an account', () => {
    expect(LEGAL_LINKS.map((l) => l.route)).toEqual([...LEGAL_ROUTES]);
    for (const l of LEGAL_LINKS) {
      expect(parseRoute(routeHref(l.route))).toBe(l.route);
      expect(guardRoute(l.route, 'anonymous')).toBeNull();
      expect(LEGAL_TITLES[l.route]).toBeTruthy();
    }
  });

  it('fetch a page and the public config', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const body = url.endsWith('/config')
        ? { registration: { mode: 'invite' } }
        : { page: 'impressum', markdown: '# Impressum', template: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const page = await legalApi.page('impressum', undefined, fake);
    expect(page.ok && page.value.template).toBe(true);
    const config = await legalApi.config(undefined, fake);
    expect(config.ok && config.value.registration.mode).toBe('invite');
    expect(calls).toEqual(['/api/legal/impressum', '/api/config']);
  });
});
