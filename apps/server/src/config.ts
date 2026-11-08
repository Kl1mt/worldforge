import type { SmtpSettings } from './mail/mailer.js';

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

/**
 * Ticket 5.7 (docs/DEPLOY.md "Email"): how the server sends mail.
 * - `smtp`: `SMTP_HOST` is set; `MAIL_FROM` and `PUBLIC_BASE_URL` are then required.
 * - `none`: production without `SMTP_HOST`. The server starts; verification and reset answer
 *   `503 email_unavailable`, and nothing blocks login.
 * - `log`: development without `SMTP_HOST`; mails (links included) go to the server log.
 */
export interface MailConfig {
  transport: 'smtp' | 'log' | 'none';
  smtp: SmtpSettings | null;
  /** Where links in mails point, e.g. `https://play.example.com`. Null only with `none`. */
  publicBaseUrl: string | null;
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
  /** Ticket 5.7. */
  mail: MailConfig;
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
    mail: mailEnv(env),
  };
}

const DEV_PUBLIC_BASE_URL = 'http://localhost:5173';

function publicBaseUrlEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid PUBLIC_BASE_URL: ${raw} (expected e.g. https://play.example.com)`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid PUBLIC_BASE_URL: ${raw} (expected an http(s):// URL)`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`Invalid PUBLIC_BASE_URL: ${raw} (no query, fragment or credentials)`);
  }
  return url.toString().replace(/\/+$/, '');
}

function mailEnv(env: NodeJS.ProcessEnv): MailConfig {
  const host = env.SMTP_HOST?.trim();
  const production = env.NODE_ENV === 'production';
  if (!host) {
    // Without mail the links are never used: a missing or odd value must not stop the start.
    let publicBaseUrl: string | null;
    try {
      publicBaseUrl = publicBaseUrlEnv(env);
    } catch {
      publicBaseUrl = null;
    }
    return production
      ? { transport: 'none', smtp: null, publicBaseUrl }
      : { transport: 'log', smtp: null, publicBaseUrl: publicBaseUrl ?? DEV_PUBLIC_BASE_URL };
  }
  const publicBaseUrl = publicBaseUrlEnv(env);
  // SMTP is configured: a half-finished configuration fails the start loudly instead of sending
  // broken links or nothing at all.
  const from = env.MAIL_FROM?.trim();
  if (!from)
    throw new Error(
      'SMTP_HOST is set but MAIL_FROM is not (e.g. Worldforge <no-reply@example.com>)',
    );
  if (/[\r\n]/.test(from) || !/@/.test(from)) throw new Error(`Invalid MAIL_FROM: ${from}`);
  if (!publicBaseUrl) {
    throw new Error('SMTP_HOST is set but PUBLIC_BASE_URL is not (e.g. https://play.example.com)');
  }
  if (production && !publicBaseUrl.startsWith('https://')) {
    throw new Error(`PUBLIC_BASE_URL must use https:// in production: ${publicBaseUrl}`);
  }
  const port = intEnv(env, 'SMTP_PORT', 587, 1, 65535);
  const user = env.SMTP_USER ?? '';
  const pass = env.SMTP_PASS ?? '';
  if ((user === '') !== (pass === '')) {
    throw new Error('Set both SMTP_USER and SMTP_PASS, or neither');
  }
  return {
    transport: 'smtp',
    smtp: {
      host,
      port,
      secure: boolEnv(env, 'SMTP_SECURE', port === 465),
      user: user === '' ? null : user,
      pass: pass === '' ? null : pass,
      from,
    },
    publicBaseUrl,
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
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env (see docs/DEVELOPMENT.md).',
    );
  }
  return config.databaseUrl;
}
