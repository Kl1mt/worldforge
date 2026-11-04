export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
  /** PostgreSQL connection string. Required to start the server or run migrations. */
  databaseUrl: string | undefined;
  databasePoolMax: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
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
  };
}

/** Like `loadConfig`, but fails fast when `DATABASE_URL` is missing. */
export function requireDatabaseUrl(config: ServerConfig): string {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env (see README).');
  }
  return config.databaseUrl;
}
