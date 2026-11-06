// `pnpm admin:invite <create|list|revoke>` (ticket D.2, docs/DEPLOY.md "Registration"). The only
// way to create invite codes: there is no API path for it. Uses DATABASE_URL. In production run
// through `deploy/admin.sh invite …` (the `admin:invite:prod` build in the server container).
import { loadConfig, requireDatabaseUrl } from '../config.js';
import { createPostgresDatabase } from '../db/client.js';
import {
  DEFAULT_INVITE_TTL_MS,
  createInvite,
  inviteStatus,
  listInvites,
  parseInviteDuration,
  revokeInvite,
} from './invites.js';

const USAGE = `Usage:
  pnpm admin:invite create [--uses N] [--expires 14d|12h|30m|never] [--note "…"]
                                         (defaults: 1 use, expires in 14 days)
  pnpm admin:invite list
  pnpm admin:invite revoke <invite id|code>`;

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const m = /^--(uses|expires|note)(?:=(.*))?$/.exec(arg);
    if (!m) usage(`Unknown argument: ${arg}`);
    const value = m[2] ?? args[++i];
    if (value === undefined) usage(`Missing value for --${m[1]}`);
    flags[m[1]!] = value;
  }
  return flags;
}

const [command, ...rest] = process.argv.slice(2);
if (command !== 'create' && command !== 'list' && command !== 'revoke') usage();

let createInput: { maxUses: number; ttlMs: number | null; note: string } | undefined;
if (command === 'create') {
  const flags = parseFlags(rest);
  const maxUses = flags.uses === undefined ? 1 : Number(flags.uses);
  if (!Number.isInteger(maxUses) || maxUses < 1) usage(`Invalid --uses: ${flags.uses}`);
  let ttlMs: number | null;
  try {
    ttlMs =
      flags.expires === undefined ? DEFAULT_INVITE_TTL_MS : parseInviteDuration(flags.expires);
  } catch (err) {
    usage((err as Error).message);
  }
  createInput = { maxUses, ttlMs, note: flags.note ?? '' };
} else if (command === 'revoke' && rest.length !== 1) {
  usage();
} else if (command === 'list' && rest.length > 0) {
  usage();
}

const fmt = (d: Date | null) => (d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : 'never');

const config = loadConfig();
const database = createPostgresDatabase({ url: requireDatabaseUrl(config), poolMax: 1 });
try {
  const now = new Date();
  if (createInput) {
    const { code, invite } = await createInvite(
      database.db,
      {
        maxUses: createInput.maxUses,
        expiresAt: createInput.ttlMs === null ? null : new Date(now.getTime() + createInput.ttlMs),
        note: createInput.note,
        via: 'cli',
      },
      now,
    );
    // The only time the code is shown: it is stored hashed.
    console.log(`Invite code: ${code}`);
    const domain = process.env.DOMAIN?.trim();
    const link = `${domain ? `https://${domain}` : 'https://<your-domain>'}/#/register?invite=${code}`;
    console.log(`Link:        ${link}`);
    console.log(
      `Id ${invite.id}, ${invite.maxUses} use${invite.maxUses === 1 ? '' : 's'}, expires ${fmt(invite.expiresAt)}.`,
    );
    console.log('Copy it now: the code is stored hashed and cannot be shown again.');
  } else if (command === 'list') {
    const invites = await listInvites(database.db);
    if (invites.length === 0) console.log('No invite codes yet.');
    for (const i of invites) {
      console.log(
        [
          i.id,
          inviteStatus(i, now).padEnd(7),
          `${i.uses}/${i.maxUses} used`.padEnd(12),
          `created ${fmt(i.createdAt)}`,
          `expires ${fmt(i.expiresAt)}`,
          i.note ? `note: ${i.note}` : '',
        ]
          .filter(Boolean)
          .join('  '),
      );
    }
  } else {
    const result = await revokeInvite(database.db, rest[0]!, now);
    if (!result) {
      console.error(`No invite with id or code "${rest[0]}".`);
      process.exitCode = 1;
    } else if (!result.changed) {
      console.log(`Invite ${result.invite.id} was already revoked.`);
    } else {
      console.log(
        `Invite ${result.invite.id} revoked (${result.invite.uses}/${result.invite.maxUses} used). Accounts it created stay.`,
      );
    }
  }
} catch (err) {
  console.error('Invite command failed:', err);
  process.exitCode = 1;
} finally {
  await database.close();
}
