import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses defaults', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: 3000, logLevel: 'info' });
  });

  it('reads env overrides', () => {
    expect(loadConfig({ PORT: '4000', HOST: '0.0.0.0', LOG_LEVEL: 'debug' })).toEqual({
      host: '0.0.0.0',
      port: 4000,
      logLevel: 'debug',
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });
});
