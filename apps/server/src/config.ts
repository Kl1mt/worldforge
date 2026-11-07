/**
 * Who may create an account (ticket D.2, docs/DEPLOY.md "Registration"): `open` (anyone),
 * `invite` (a valid invite code from `pnpm admin:invite`), `closed` (nobody). Login and existing
 * sessions never depend on it.
 */
export const REGISTRATION_MODES = ['open', 'invite', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export function isRegistrationMode(value: unknown): value is RegistrationMode {
  return (REGISTRATION_MODES as readonly unknown[]).includes(value);
}

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
  /** Ticket D.2. Default `open` (dev, tests, playtest, e2e); production sets `invite`. */
  registrationMode: RegistrationMode;
  /**
   * Ticket D.2: directory with the owner's `impressum.md` / `datenschutz.md`. A file missing there
   * falls back to the template shipped in `content/legal/`. Unset: templates only.
   */
  legalDir: string | undefined;
  /**
   * Ticket D.3: what the running image was built from, for the admin panel's server status.
   * `deploy/Dockerfile` bakes `WORLDFORGE_GIT_SHA` and `WORLDFORGE_BUILD_TIME` in; null when unset
   * (development).
   */
  build: { gitSha: string | null; buildTime: string | null };
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

function registrationModeEnv(env: NodeJS.ProcessEnv): RegistrationMode {
  const raw = env.REGISTRATION_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'open';
  if (!isRegistrationMode(raw)) {
    throw new Error(
      `Invalid REGISTRATION_MODE: ${env.REGISTRATION_MODE} (expected ${REGISTRATION_MODES.join('|')})`,
    );
  }
  return raw;
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
    registrationMode: registrationModeEnv(env),
    legalDir: env.LEGAL_DIR?.trim() || undefined,
    build: {
      gitSha: buildEnv(env.WORLDFORGE_GIT_SHA, /^[0-9a-f]{7,40}$/i),
      buildTime: buildEnv(env.WORLDFORGE_BUILD_TIME, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    },
  };
}

/** A build label, or null when unset, `unknown` or malformed (never fails the start). */
function buildEnv(raw: string | undefined, shape: RegExp): string | null {
  const v = raw?.trim();
  return v && shape.test(v) ? v : null;
}

/** Like `loadConfig`, but fails fast when `DATABASE_URL` is missing. */
export function requireDatabaseUrl(config: ServerConfig): string {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env (see docs/DEVELOPMENT.md).');
  }
  return config.databaseUrl;
}
