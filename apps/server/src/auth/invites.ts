import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { inviteCodes, type InviteCode } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';

/**
 * Invite codes (ticket D.2, docs/DEPLOY.md "Registration"). A code is 16 random characters from
 * Crockford's base32 alphabet (80 bits from `crypto.randomBytes`, not derived from anything),
 * shown as `XXXX-XXXX-XXXX-XXXX`. Only its SHA-256 is stored: with 80 random bits a fast hash is
 * enough (like session tokens), and registration is rate-limited per IP on top.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

export const DEFAULT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_INVITE_USES = 10_000;
export const INVITE_NOTE_MAX = 200;

export function newInviteCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = '';
  // 256 is a multiple of 32, so masking keeps every character equally likely.
  for (const b of bytes) raw += ALPHABET[b & 31];
  return raw.match(/.{4}/g)!.join('-');
}

/**
 * What the player typed (or the link carried) → the canonical 16 characters, or `null` when it
 * cannot be a code. Case, spaces and dashes do not matter; O/I/L read as 0/1/1 (Crockford).
 */
export function normalizeInviteCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(s) ? s : null;
}

export function inviteCodeHash(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

export type InviteStatus = 'active' | 'used_up' | 'expired' | 'revoked';

export function inviteStatus(invite: InviteCode, now: Date): InviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (invite.uses >= invite.maxUses) return 'used_up';
  return 'active';
}

/** `14d`, `12h`, `30m` → milliseconds; `never` → `null`. Throws on anything else. */
export function parseInviteDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === 'never') return null;
  const m = /^(\d{1,4})([dhm])$/.exec(s);
  if (!m) throw new Error(`Invalid duration "${input}" (expected e.g. 14d, 12h, 30m or never)`);
  const n = Number(m[1]);
  if (n < 1) throw new Error(`Invalid duration "${input}" (must be at least 1)`);
  const unit = { d: 24 * 60 * 60 * 1000, h: 60 * 60 * 1000, m: 60 * 1000 }[m[2] as 'd' | 'h' | 'm'];
  return n * unit;
}

export interface CreateInviteInput {
  maxUses: number;
  /** Null: never expires. */
  expiresAt: Date | null;
  note: string;
  createdByAccountId?: string | null;
  via: 'cli';
}

export interface CreatedInvite {
  /** The plain code. Returned once, never stored or logged. */
  code: string;
  invite: InviteCode;
}

export async function createInvite(
  db: Database,
  input: CreateInviteInput,
  now: Date,
): Promise<CreatedInvite> {
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > MAX_INVITE_USES) {
    throw new Error(`Invalid uses: ${input.maxUses} (1–${MAX_INVITE_USES})`);
  }
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
    throw new Error('The expiry must be in the future');
  }
  const note = input.note.trim();
  if (note.length > INVITE_NOTE_MAX) throw new Error(`Note too long (max ${INVITE_NOTE_MAX})`);
  const code = newInviteCode();
  const invite = await withTransaction(db, async (tx) => {
    const [row] = await tx
      .insert(inviteCodes)
      .values({
        id: uuidv7(),
        codeHash: inviteCodeHash(normalizeInviteCode(code)!),
        maxUses: input.maxUses,
        expiresAt: input.expiresAt,
        note,
        createdByAccountId: input.createdByAccountId ?? null,
        createdAt: now,
      })
      .returning();
    await writeAudit(tx, {
      event: 'invite.create',
      accountId: input.createdByAccountId ?? null,
      data: {
        inviteId: row!.id,
        maxUses: row!.maxUses,
        expiresAt: row!.expiresAt?.toISOString() ?? null,
        via: input.via,
      },
    });
    return row!;
  });
  return { code, invite };
}

/** Every invite, newest first (admins only: the CLI). */
export async function listInvites(db: Database): Promise<InviteCode[]> {
  return db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt), desc(inviteCodes.id));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes an invite by its id or by the code itself. Already-created accounts stay. Returns
 * `null` when there is no such invite; `changed: false` when it was already revoked.
 */
export async function revokeInvite(
  db: Database,
  idOrCode: string,
  now: Date,
): Promise<{ invite: InviteCode; changed: boolean } | null> {
  const s = idOrCode.trim();
  const normalized = UUID_RE.test(s) ? null : normalizeInviteCode(s);
  if (!UUID_RE.test(s) && !normalized) return null;
  const where = normalized
    ? eq(inviteCodes.codeHash, inviteCodeHash(normalized))
    : eq(inviteCodes.id, s.toLowerCase());
  return withTransaction(db, async (tx) => {
    const [row] = await tx.select().from(inviteCodes).where(where).for('update');
    if (!row) return null;
    if (row.revokedAt) return { invite: row, changed: false };
    const [updated] = await tx
      .update(inviteCodes)
      .set({ revokedAt: now })
      .where(eq(inviteCodes.id, row.id))
      .returning();
    await writeAudit(tx, {
      event: 'invite.revoke',
      data: { inviteId: row.id, uses: row.uses, via: 'cli' },
    });
    return { invite: updated!, changed: true };
  });
}

/**
 * Uses one redemption of the code inside the registration transaction, or returns `null` when
 * the code is unknown, revoked, expired or used up. One conditional UPDATE: concurrent
 * registrations queue on the row lock and re-check `uses < max_uses`, so a code with N uses
 * creates at most N accounts; a later failure in the transaction (e.g. email taken) rolls the
 * use back.
 */
export async function redeemInvite(tx: Executor, input: string, now: Date): Promise<string | null> {
  const normalized = normalizeInviteCode(input);
  if (!normalized) return null;
  const [row] = await tx
    .update(inviteCodes)
    .set({ uses: sql`${inviteCodes.uses} + 1` })
    .where(
      and(
        eq(inviteCodes.codeHash, inviteCodeHash(normalized)),
        isNull(inviteCodes.revokedAt),
        or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
        lt(inviteCodes.uses, inviteCodes.maxUses),
      ),
    )
    .returning({ id: inviteCodes.id });
  return row?.id ?? null;
}
