import { buildApp } from './app.js';
import { loadConfig, requireDatabaseUrl } from './config.js';
import { createPostgresDatabase } from './db/client.js';
import { DISABLED_MAILER, createLogMailer, createSmtpMailer, type Mailer } from './mail/mailer.js';

const config = loadConfig();
const database = createPostgresDatabase({
  url: requireDatabaseUrl(config),
  poolMax: config.databasePoolMax,
  onIdleError: (err) => app.log.warn({ err }, 'idle database connection lost'),
});
// Ticket 5.7 (docs/DEPLOY.md "Email"): SMTP when configured; production without it has no mail.
const mailer: Mailer =
  config.mail.transport === 'smtp'
    ? createSmtpMailer(config.mail.smtp!)
    : config.mail.transport === 'log'
      ? createLogMailer((m) =>
          app.log.info(
            { mail: m.kind, to: m.to, subject: m.subject, text: m.text },
            'mail (dev log)',
          ),
        )
      : DISABLED_MAILER;
const app = buildApp({
  logger: { level: config.logLevel },
  trustProxy: config.trustProxy,
  database,
  auth: {
    sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1000,
    cookieSecure: config.sessionCookieSecure,
    registrationMode: config.registrationMode,
    mailer,
    ...(config.mail.publicBaseUrl ? { publicBaseUrl: config.mail.publicBaseUrl } : {}),
  },
  legal: { dir: config.legalDir },
  admin: { build: config.build },
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
  if (config.mail.transport === 'none') {
    app.log.warn('email is not set up (no SMTP_HOST): verification and password reset are off');
  } else {
    app.log.info({ transport: config.mail.transport }, 'email is set up');
  }
  // A wrong SMTP host or password shows in the log at start, not at the first player's reset.
  mailer.verify?.().then(
    () => app.log.info('SMTP connection and login ok'),
    (err: unknown) => {
      const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
      app.log.error(
        { code: e?.code, responseCode: e?.responseCode, command: e?.command },
        'SMTP check failed: mails will not be sent until the settings are fixed',
      );
    },
  );
} catch (err) {
  app.log.error(err);
  await database.close().catch(() => undefined);
  process.exit(1);
}
