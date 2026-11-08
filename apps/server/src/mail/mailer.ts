import { createTransport } from 'nodemailer';

/**
 * Outgoing mail (ticket 5.7, docs/DEPLOY.md "Email"). Provider-agnostic: production talks plain
 * SMTP to whatever service the owner configures on the VPS (`SMTP_*`, `MAIL_FROM`); nothing about a
 * provider is in the code. Development logs mails, tests capture them in memory, and production
 * without SMTP settings has no mailer at all (`enabled: false`): the server still starts, nothing
 * blocks login, and the mail routes answer `503 email_unavailable`.
 */
export const MAIL_KINDS = [
  'verify_email',
  'reset_password',
  'password_changed',
  'email_changed',
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export interface MailMessage {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly transport: 'smtp' | 'log' | 'memory' | 'none';
  /** False only for `none`: verification and reset are unavailable, everything else works. */
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
  /** Checks the connection and login (SMTP only), for a startup log line. */
  verify?(): Promise<void>;
  close?(): void;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS (usually port 465). Otherwise STARTTLS is required. */
  secure: boolean;
  user: string | null;
  pass: string | null;
  /** `Worldforge <no-reply@example.com>`. */
  from: string;
}

/** Production: one pooled SMTP connection to the owner's provider. */
export function createSmtpMailer(settings: SmtpSettings): Mailer {
  const transporter = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // Never send credentials or links in clear text: without implicit TLS, STARTTLS is required.
    requireTLS: !settings.secure,
    ...(settings.user !== null && settings.pass !== null
      ? { auth: { user: settings.user, pass: settings.pass } }
      : {}),
    pool: true,
    maxConnections: 2,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    transport: 'smtp',
    enabled: true,
    async send(m) {
      await transporter.sendMail({
        from: settings.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
      });
    },
    async verify() {
      await transporter.verify();
    },
    close() {
      transporter.close();
    },
  };
}

export interface MemoryMailer extends Mailer {
  readonly outbox: MailMessage[];
  /** The newest mail of a kind sent to an address, or undefined. */
  last(to: string, kind?: MailKind): MailMessage | undefined;
}

/**
 * Tests and the e2e server: every mail is kept in `outbox` (synchronously, as `send` is called),
 * so a test reads the link from the captured mail. `onSend` lets the e2e server write them out.
 * Never sends anything anywhere.
 */
export function createMemoryMailer(onSend?: (m: MailMessage) => void): MemoryMailer {
  const outbox: MailMessage[] = [];
  return {
    transport: 'memory',
    enabled: true,
    outbox,
    last(to, kind) {
      const lower = to.toLowerCase();
      for (let i = outbox.length - 1; i >= 0; i -= 1) {
        const m = outbox[i]!;
        if (m.to.toLowerCase() === lower && (kind === undefined || m.kind === kind)) return m;
      }
      return undefined;
    },
    send(m) {
      outbox.push(m);
      onSend?.(m);
      return Promise.resolve();
    },
  };
}

/** Development (`pnpm dev`, no SMTP settings): the mail is printed to the server log, links included. */
export function createLogMailer(log: (m: MailMessage) => void): Mailer {
  return {
    transport: 'log',
    enabled: true,
    send(m) {
      log(m);
      return Promise.resolve();
    },
  };
}

/** Production without SMTP settings, and the default of `buildApp` (tests opt in to a mailer). */
export const DISABLED_MAILER: Mailer = {
  transport: 'none',
  enabled: false,
  send() {
    return Promise.reject(new Error('email is not set up on this server'));
  },
};

/** The first link in a mail's plain text (tests and the e2e helpers read tokens this way). */
export function linkIn(m: MailMessage): string | null {
  return /https?:\/\/\S+/.exec(m.text)?.[0] ?? null;
}

/** The `token` parameter of the first link in a mail, or null. */
export function tokenIn(m: MailMessage): string | null {
  const link = linkIn(m);
  if (!link) return null;
  const query = link.slice(link.indexOf('?') + 1);
  return new URLSearchParams(query).get('token');
}
