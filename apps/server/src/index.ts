import { buildApp } from './app.js';
import { loadConfig, requireDatabaseUrl } from './config.js';
import { createPostgresDatabase } from './db/client.js';

const config = loadConfig();
const database = createPostgresDatabase({
  url: requireDatabaseUrl(config),
  poolMax: config.databasePoolMax,
  onIdleError: (err) => app.log.warn({ err }, 'idle database connection lost'),
});
const app = buildApp({
  logger: { level: config.logLevel },
  trustProxy: config.trustProxy,
  database,
  auth: {
    sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1000,
    cookieSecure: config.sessionCookieSecure,
  },
  activity: {
    offlineCapMs: config.offlineCapSeconds * 1000,
    settleIntervalMs: config.settleIntervalSeconds * 1000,
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  // Fail fast on a wrong URL/credentials instead of on the first request.
  await database.ping(5000);
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  await database.close().catch(() => undefined);
  process.exit(1);
}
