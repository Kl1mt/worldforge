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
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 4000,
      logLevel: 'debug',
      databaseUrl: 'postgres://u:p@db:5432/wf',
      databasePoolMax: 20,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });

  it('rejects a non-postgres DATABASE_URL and a bad pool size', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/Invalid DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_POOL_MAX: '0' })).toThrow(/Invalid DATABASE_POOL_MAX/);
  });

  it('requireDatabaseUrl fails fast when unset', () => {
    expect(() => requireDatabaseUrl(loadConfig({}))).toThrow(/DATABASE_URL is not set/);
    expect(requireDatabaseUrl(loadConfig({ DATABASE_URL: 'postgresql://h/db' }))).toBe(
      'postgresql://h/db',
    );
  });
});
