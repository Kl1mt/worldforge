export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
  /** PostgreSQL connection string. Required to start the server or run migrations. */
  databaseUrl: string | undefined;
  databasePoolMax: number;
  /** Session lifetime from login, in hours (default 720 = 30 days). */
  sessionTtlHours: number;
  /** `Secure` flag on the session cookie. Only turn off for plain-http testing off localhost. */
  sessionCookieSecure: boolean;
  /** Trust `X-Forwarded-For` (behind a reverse proxy), so rate limits key on the real client IP. */
  trustProxy: boolean;
  /** Offline progress accrues for at most this long after the last client contact (GDD §9.1). */
  offlineCapSeconds: number;
  /** Scheduled settlement interval; 0 disables it. */
  settleIntervalSeconds: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`Invalid ${name}: ${raw} (expected 1/0/true/false)`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('Invalid DATABASE_URL: expected a postgres:// or postgresql:// URL');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: intEnv(env, 'PORT', 3000, 0, 65535),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl,
    databasePoolMax: intEnv(env, 'DATABASE_POOL_MAX', 10, 1, 1000),
    sessionTtlHours: intEnv(env, 'SESSION_TTL_HOURS', 720, 1, 24 * 365),
    sessionCookieSecure: boolEnv(env, 'SESSION_COOKIE_SECURE', true),
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    offlineCapSeconds: intEnv(env, 'OFFLINE_CAP_SECONDS', 3 * 60 * 60, 0, 7 * 24 * 60 * 60),
    settleIntervalSeconds: intEnv(env, 'SETTLE_INTERVAL_SECONDS', 300, 0, 24 * 60 * 60),
  };
}

/** Like `loadConfig`, but fails fast when `DATABASE_URL` is missing. */
export function requireDatabaseUrl(config: ServerConfig): string {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env (see README).');
  }
  return config.databaseUrl;
}
