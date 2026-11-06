import { describe, expect, it } from 'vitest';
import { loadConfig, requireDatabaseUrl } from './config.js';

describe('loadConfig', () => {
  it('uses defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      databaseUrl: undefined,
      databasePoolMax: 10,
      sessionTtlHours: 720,
      sessionCookieSecure: true,
      trustProxy: false,
      offlineCapSeconds: 10800,
      settleIntervalSeconds: 300,
      registrationMode: 'open',
      legalDir: undefined,
    });
  });

  it('reads env overrides', () => {
    expect(
      loadConfig({
        PORT: '4000',
        HOST: '0.0.0.0',
        LOG_LEVEL: 'debug',
        DATABASE_URL: 'postgres://u:p@db:5432/wf',
        DATABASE_POOL_MAX: '20',
        SESSION_TTL_HOURS: '24',
        SESSION_COOKIE_SECURE: '0',
        TRUST_PROXY: 'true',
        OFFLINE_CAP_SECONDS: '3600',
        SETTLE_INTERVAL_SECONDS: '0',
        REGISTRATION_MODE: 'invite',
        LEGAL_DIR: '/srv/legal',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 4000,
      logLevel: 'debug',
      databaseUrl: 'postgres://u:p@db:5432/wf',
      databasePoolMax: 20,
      sessionTtlHours: 24,
      sessionCookieSecure: false,
      trustProxy: true,
      offlineCapSeconds: 3600,
      settleIntervalSeconds: 0,
      registrationMode: 'invite',
      legalDir: '/srv/legal',
    });
  });

  it('parses REGISTRATION_MODE (ticket D.2)', () => {
    expect(loadConfig({ REGISTRATION_MODE: '' }).registrationMode).toBe('open');
    expect(loadConfig({ REGISTRATION_MODE: 'open' }).registrationMode).toBe('open');
    expect(loadConfig({ REGISTRATION_MODE: ' Invite ' }).registrationMode).toBe('invite');
    expect(loadConfig({ REGISTRATION_MODE: 'closed' }).registrationMode).toBe('closed');
    expect(() => loadConfig({ REGISTRATION_MODE: 'invites' })).toThrow(/REGISTRATION_MODE/);
    expect(loadConfig({ LEGAL_DIR: '  ' }).legalDir).toBeUndefined();
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });

  it('rejects a non-postgres DATABASE_URL and a bad pool size', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/Invalid DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_POOL_MAX: '0' })).toThrow(/Invalid DATABASE_POOL_MAX/);
  });

  it('rejects bad auth settings', () => {
    expect(() => loadConfig({ SESSION_COOKIE_SECURE: 'yes' })).toThrow(/SESSION_COOKIE_SECURE/);
    expect(() => loadConfig({ SESSION_TTL_HOURS: '0' })).toThrow(/SESSION_TTL_HOURS/);
  });

  it('requireDatabaseUrl fails fast when unset', () => {
    expect(() => requireDatabaseUrl(loadConfig({}))).toThrow(/DATABASE_URL is not set/);
    expect(requireDatabaseUrl(loadConfig({ DATABASE_URL: 'postgresql://h/db' }))).toBe(
      'postgresql://h/db',
    );
  });
});
