import { describe, expect, it } from 'vitest';
import { describeAuthFailure } from '../auth/api';
import { apiRequest } from './api';

const respond = (res: Response | (() => never)) =>
  (async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch;

describe('apiRequest', () => {
  it('returns the parsed body on success', async () => {
    const r = await apiRequest('/x', {}, respond(Response.json({ a: 1 })));
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it('treats 204 as success without a body', async () => {
    const r = await apiRequest(
      '/x',
      { method: 'POST' },
      respond(new Response(null, { status: 204 })),
    );
    expect(r).toEqual({ ok: true, value: undefined });
  });

  it('reads the error envelope, field errors and retry hints', async () => {
    const body = {
      error: {
        code: 'rate_limited',
        message: 'Too many attempts.',
        details: { retryAfterSeconds: 42, fields: { email: 'Bad.', junk: 3 } },
      },
    };
    const r = await apiRequest('/x', {}, respond(Response.json(body, { status: 429 })));
    expect(r).toEqual({
      ok: false,
      error: {
        status: 429,
        code: 'rate_limited',
        message: 'Too many attempts.',
        fields: { email: 'Bad.' },
        retryAfterSeconds: 42,
        details: body.error.details,
      },
    });
  });

  it('copes with a non-envelope error body', async () => {
    const r = await apiRequest('/x', {}, respond(new Response('<html>', { status: 502 })));
    expect(r).toMatchObject({ ok: false, error: { status: 502, code: 'bad_response' } });
  });

  it('maps a network failure to code "network"', async () => {
    const r = await apiRequest(
      '/x',
      {},
      respond(() => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(r).toMatchObject({ ok: false, error: { status: 0, code: 'network' } });
  });

  it('sends JSON bodies to /api with same-origin credentials', async () => {
    let seen: [string, RequestInit | undefined] | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = [url, init];
      return Response.json({});
    }) as unknown as typeof fetch;
    await apiRequest('/auth/login', { method: 'POST', body: { email: 'a' } }, spy);
    expect(seen?.[0]).toBe('/api/auth/login');
    expect(seen?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a"}',
    });
  });
});

describe('describeAuthFailure', () => {
  it('explains invite and closed-registration refusals (ticket D.2)', () => {
    expect(describeAuthFailure({ code: 'invite_invalid', message: '' })).toMatch(/invite code/);
    expect(describeAuthFailure({ code: 'registration_closed', message: '' })).toMatch(/closed/);
  });

  it('keeps failed logins generic', () => {
    expect(describeAuthFailure({ code: 'invalid_credentials', message: 'x' })).toBe(
      'That email and password do not match an account.',
    );
  });

  it('turns rate limits into a wait time', () => {
    expect(describeAuthFailure({ code: 'rate_limited', message: '', retryAfterSeconds: 30 })).toBe(
      'Too many attempts. Try again in 30 seconds.',
    );
    expect(
      describeAuthFailure({ code: 'rate_limited', message: '', retryAfterSeconds: 1800 }),
    ).toBe('Too many attempts. Try again in 30 minutes.');
  });

  it('points at the fields for validation problems and hides internals otherwise', () => {
    expect(describeAuthFailure({ code: 'email_taken', message: '' })).toBe(
      'Some fields need attention.',
    );
    expect(describeAuthFailure({ code: 'internal_error', message: 'stack' })).not.toContain(
      'stack',
    );
  });
});
