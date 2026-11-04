import { describe, expect, it } from 'vitest';
import { fetchHealth } from './health';

const fakeFetch = (impl: () => Promise<Response>) => (() => impl()) as unknown as typeof fetch;

describe('fetchHealth', () => {
  it('returns ok for a healthy server', async () => {
    const f = fakeFetch(async () => Response.json({ status: 'ok', uptimeSeconds: 12 }));
    expect(await fetchHealth(f)).toEqual({ kind: 'ok', uptimeSeconds: 12 });
  });

  it('reports a non-2xx response', async () => {
    const f = fakeFetch(async () => new Response('nope', { status: 502 }));
    expect(await fetchHealth(f)).toEqual({ kind: 'error', message: 'Server responded 502' });
  });

  it('reports an unexpected body', async () => {
    const f = fakeFetch(async () => Response.json({ hello: 'world' }));
    expect(await fetchHealth(f)).toEqual({ kind: 'error', message: 'Unexpected health response' });
  });

  it('reports a network failure', async () => {
    const f = fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fetchHealth(f)).toEqual({ kind: 'error', message: 'Server unreachable' });
  });
});
