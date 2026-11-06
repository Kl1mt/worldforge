import { describe, expect, it } from 'vitest';
import { describeSanction, describeSocialFailure, sanctionOf, type Sanction } from './api';

const mute: Sanction = {
  id: 's1',
  kind: 'mute',
  reason: 'Spam',
  createdAt: '2026-11-06T12:00:00.000Z',
  expiresAt: '2026-11-07T12:00:00.000Z',
  target: null,
};

describe('social copy', () => {
  it('says what a sanction means and until when', () => {
    expect(describeSanction(mute)).toMatch(/muted until 7 November 2026.*12:00 UTC/);
    expect(describeSanction({ ...mute, kind: 'suspend' })).toMatch(/suspended until/);
    expect(describeSanction({ ...mute, kind: 'rename' })).toMatch(/Choose a new one/);
  });

  it('reads the sanction out of a 403 failure', () => {
    const failure = {
      status: 403,
      code: 'muted',
      message: 'x',
      fields: {},
      details: { sanction: mute },
    };
    expect(sanctionOf(failure)).toEqual(mute);
    expect(describeSocialFailure(failure)).toMatch(/muted until/);
    expect(sanctionOf({ details: {} })).toBeNull();
  });

  it('explains report failures', () => {
    const f = (code: string, extra = {}) =>
      describeSocialFailure({ status: 409, code, message: '', fields: {}, ...extra });
    expect(f('report_open')).toMatch(/already reported/);
    expect(f('rate_limited', { retryAfterSeconds: 30 })).toMatch(/30 seconds/);
    expect(f('validation_failed', { fields: { note: 'Use at most 500 characters.' } })).toBe(
      'Use at most 500 characters.',
    );
  });
});
