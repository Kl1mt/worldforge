import { describe, expect, it } from 'vitest';
import { describeAdminFailure, docHref, formatUptime, inviteLink } from './api';

describe('admin panel helpers (ticket D.3)', () => {
  it('builds the hash-form invite link on the given origin', () => {
    expect(inviteLink('ABCD-EFGH-JKMN-PQRS', 'https://play.worldforg.ing')).toBe(
      'https://play.worldforg.ing/#/register?invite=ABCD-EFGH-JKMN-PQRS',
    );
  });

  it('formats uptime coarsely', () => {
    expect(formatUptime(59)).toBe('0 min');
    expect(formatUptime(3 * 3600 + 120)).toBe('3 h 2 min');
    expect(formatUptime(2 * 86_400 + 5 * 3600)).toBe('2 d 5 h');
  });

  it('explains failures', () => {
    const f = (code: string, status = 400, extra = {}) =>
      describeAdminFailure({ status, code, message: 'msg', fields: {}, ...extra });
    expect(f('network', 0)).toMatch(/cannot be reached/);
    expect(f('rate_limited', 429, { retryAfterSeconds: 200 })).toMatch(/4 minutes/);
    expect(f('internal_error', 500)).toMatch(/failed/);
    expect(f('validation_failed')).toBe('msg');
  });
});

describe('readiness doc links (ticket 8.6)', () => {
  it('points at the heading in the public repository', () => {
    expect(docHref('docs/DEPLOY.md', 'email')).toBe(
      'https://github.com/Kl1mt/worldforge/blob/main/docs/DEPLOY.md#email',
    );
    expect(docHref('docs/GOING_LIVE.md', '')).toBe(
      'https://github.com/Kl1mt/worldforge/blob/main/docs/GOING_LIVE.md',
    );
  });
});
