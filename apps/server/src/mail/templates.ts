import type { MailKind, MailMessage } from './mailer.js';

/**
 * Mail templates (ticket 5.7): short, plain text plus simple HTML, in the game's voice. They carry
 * no personal data beyond what the mail needs: no display name, no handle, no other address (the
 * "email changed" notice to the old address does not name the new one). Every link starts with the
 * configured public base URL; tokens travel in the URL fragment (`#/…?token=`), which browsers
 * never send to a server, so they stay out of proxy and access logs.
 */

/** Builds the links in mails from the configured public base URL (`PUBLIC_BASE_URL`). */
export function mailLinks(publicBaseUrl: string) {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return {
    verify: (token: string) => `${base}/#/verify?token=${encodeURIComponent(token)}`,
    reset: (token: string) => `${base}/#/reset?token=${encodeURIComponent(token)}`,
    forgot: () => `${base}/#/forgot`,
    impressum: () => `${base}/#/impressum`,
  };
}
export type MailLinks = ReturnType<typeof mailLinks>;

const SIGN_OFF = '— The keeper of the Graumark ledger';
const FOOTER = 'You get this letter because of your Worldforge account. Replies are not read.';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Letter {
  kind: MailKind;
  to: string;
  subject: string;
  /** Paragraphs before the link. */
  lines: string[];
  link?: { href: string; label: string };
  /** Paragraphs after the link. */
  after: string[];
}

function compose(l: Letter): MailMessage {
  const text = [
    ...l.lines,
    ...(l.link ? [`${l.link.label}:\n${l.link.href}`] : []),
    ...l.after,
    SIGN_OFF,
    '--',
    FOOTER,
  ].join('\n\n');
  const p = (s: string) => `<p style="margin:0 0 14px">${escapeHtml(s)}</p>`;
  const button = l.link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(l.link.href)}" style="background:#6b4a1f;color:#f3e7c9;padding:10px 18px;text-decoration:none;border-radius:2px;font-weight:bold">${escapeHtml(l.link.label)}</a></p>` +
      `<p style="margin:0 0 14px;font-size:13px;color:#6f6656">If the button does not work, open this address:<br><span style="word-break:break-all">${escapeHtml(l.link.href)}</span></p>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(l.subject)}</title></head>
<body style="margin:0;padding:24px;background:#efe7d6;color:#2a241c;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.5">
<div style="max-width:520px;margin:0 auto;background:#faf5ea;border:1px solid #c9b78f;padding:24px 28px">
<p style="margin:0 0 18px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#6b4a1f">Worldforge · Graumark</p>
${l.lines.map(p).join('\n')}
${button}
${l.after.map(p).join('\n')}
<p style="margin:18px 0 0;font-style:italic">${escapeHtml(SIGN_OFF)}</p>
</div>
<p style="max-width:520px;margin:12px auto 0;font-size:12px;color:#6f6656">${escapeHtml(FOOTER)}</p>
</body></html>`;
  return { kind: l.kind, to: l.to, subject: l.subject, text, html };
}

function hours(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h === 1 ? '1 hour' : `${h} hours`;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}

export function verifyEmailMail(to: string, link: string, ttlMs: number): MailMessage {
  return compose({
    kind: 'verify_email',
    to,
    subject: 'Seal your name in the Graumark ledger',
    lines: [
      'Hail, traveller.',
      'Someone wrote this address into the Graumark ledger for a Worldforge account. Seal it with the link below, so the ledger knows the address is truly yours.',
    ],
    link: { href: link, label: 'Confirm this address' },
    after: [
      `The link works once and fades after ${hours(ttlMs)}. If it was not you, ignore this letter: nothing changes without the seal.`,
    ],
  });
}

export function resetPasswordMail(to: string, link: string, ttlMs: number): MailMessage {
  return compose({
    kind: 'reset_password',
    to,
    subject: 'A new key for your Worldforge account',
    lines: [
      'Hail, traveller.',
      'Someone asked for a new password for the Worldforge account of this address. Choose a new one with the link below.',
    ],
    link: { href: link, label: 'Choose a new password' },
    after: [
      `The link works once and fades after ${minutes(ttlMs)}. Choosing a new password logs out every device.`,
      'If you did not ask for this, ignore this letter: your password stays as it is.',
    ],
  });
}

export function passwordChangedMail(to: string, forgotLink: string, at: Date): MailMessage {
  return compose({
    kind: 'password_changed',
    to,
    subject: 'Your Worldforge password was changed',
    lines: [
      'Hail, traveller.',
      `The password of your Worldforge account was changed on ${at.toISOString().slice(0, 16).replace('T', ' at ')} UTC, and every device was logged out.`,
      'If that was you, there is nothing more to do.',
    ],
    link: { href: forgotLink, label: 'If it was not you, take the key back' },
    after: [],
  });
}

export function emailChangedMail(to: string, impressumLink: string): MailMessage {
  return compose({
    kind: 'email_changed',
    to,
    subject: 'Your Worldforge account has a new email address',
    lines: [
      'Hail, traveller.',
      'The email address of your Worldforge account was changed, so letters about the account no longer come here.',
      'If that was you, there is nothing more to do.',
      'If it was not you, someone knows your password. Write to the keeper of the game at the contact address on its Impressum page, from this address, so the account can be given back to you.',
    ],
    link: { href: impressumLink, label: 'The Impressum page' },
    after: [],
  });
}
