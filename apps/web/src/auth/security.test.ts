import { describe, expect, it } from 'vitest';
import { authApi, describeAuthFailure } from './api';
import { guardRoute, isTokenRoute, parseRoute, tokenFromHash, TOKEN_ROUTES } from '../lib/route';

const TOKEN = 'a'.repeat(21) + '_-' + 'B'.repeat(20);

describe('account security routes (ticket 5.7)', () => {
  it('parses the mail links and reads only a well-formed token', () => {
    expect(parseRoute(`#/verify?token=${TOKEN}`)).toBe('verify');
    expect(parseRoute(`#/reset?token=${TOKEN}`)).toBe('reset');
    expect(parseRoute('#/forgot')).toBe('forgot');
    expect(tokenFromHash(`#/verify?token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#/verify')).toBeNull();
    expect(tokenFromHash('#/verify?token=')).toBeNull();
    expect(tokenFromHash('#/reset?token=<script>')).toBeNull();
    expect(tokenFromHash(`#/reset?token=${'x'.repeat(200)}`)).toBeNull();
  });

  it('opens the mail links to everyone, and "forgot" only to visitors', () => {
    for (const r of TOKEN_ROUTES) {
      expect(isTokenRoute(r)).toBe(true);
      for (const s of ['anonymous', 'account', 'playing'] as const) {
        expect(guardRoute(r, s)).toBeNull();
      }
    }
    expect(guardRoute('forgot', 'anonymous')).toBeNull();
    expect(guardRoute('forgot', 'playing')).toBe('hub');
  });

  it('explains the new failures in plain words', () => {
    const f = (code: string, extra = {}) =>
      describeAuthFailure({ code, message: 'server text', ...extra });
    expect(f('rate_limited', { retryAfterSeconds: 120, details: { limit: 'account' } })).toMatch(
      /Too many wrong passwords for this account\. Try again in 2 minutes, or choose a new password/,
    );
    expect(f('rate_limited', { retryAfterSeconds: 30, details: { limit: 'mail' } })).toBe(
      'Enough letters for now. Try again in 30 seconds.',
    );
    expect(f('rate_limited', { retryAfterSeconds: 30 })).toBe(
      'Too many attempts. Try again in 30 seconds.',
    );
    expect(f('email_unavailable')).toMatch(/Email is not set up on this server yet/);
    expect(f('token_expired')).toBe('This link has expired. Ask for a new one.');
    expect(f('token_invalid')).toMatch(/already used, replaced by a newer letter/);
    expect(f('wrong_password')).toBe('That password is not right.');
  });

  it('sends the security requests to the right routes', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await authApi.forgotPassword('wren@example.test', fake);
    await authApi.resetPassword({ token: TOKEN, password: 'embers-and-salt-77' }, fake);
    await authApi.verifyEmail(TOKEN, fake);
    await authApi.resendVerification(fake);
    await authApi.changeEmail({ email: 'new@example.test', password: 'pw' }, fake);
    await authApi.revokeOtherSessions(fake);
    await authApi.security(undefined, fake);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/auth/forgot-password',
      'POST /api/auth/reset-password',
      'POST /api/auth/verify-email',
      'POST /api/account/verification',
      'POST /api/account/email',
      'POST /api/account/sessions/revoke-others',
      'GET /api/account/security',
    ]);
    expect(calls[0]!.body).toEqual({ email: 'wren@example.test' });
    expect(calls[1]!.body).toEqual({ token: TOKEN, password: 'embers-and-salt-77' });
    expect(calls[2]!.body).toEqual({ token: TOKEN });
  });
});
