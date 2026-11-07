import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isHandle, moderationDecision, type AccountRole } from '@worldforge/game-core';
import { accounts, auditLog, characters, inviteCodes, reports, sanctions } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/**
 * Read-only player lookups for the admin panel (ticket D.3). Never selects the email (decision in
 * docs/SOCIAL.md "Admin panel"): admins identify players by handle and display name, like the
 * moderator queue.
 */

export const PLAYER_SEARCH_LIMIT = 20;
const REPORTS_LIMIT = 100;

export interface PlayerRow {
  handle: string;
  displayName: string;
  role: AccountRole;
  createdAt: string;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** By exact handle or a display-name substring (case-insensitive), at most 20, by name. */
export async function searchPlayers(
  db: Executor,
  query: string,
): Promise<{ players: PlayerRow[]; truncated: boolean }> {
  const q = query.trim();
  const handle = q.toLowerCase();
  const rows = await db
    .select({
      handle: accounts.handle,
      displayName: accounts.displayName,
      role: accounts.role,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(
      or(
        sql`${accounts.displayName} ilike ${like(q)}`,
        isHandle(handle) ? eq(accounts.handle, handle) : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${accounts.displayName})`), asc(accounts.id))
    .limit(PLAYER_SEARCH_LIMIT + 1);
  return {
    players: rows.slice(0, PLAYER_SEARCH_LIMIT).map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    truncated: rows.length > PLAYER_SEARCH_LIMIT,
  };
}

const ref = (handle: string | null, displayName: string | null) =>
  handle && displayName ? { handle, displayName } : null;

/** Everything the panel shows about one player, or null for an unknown handle. */
export async function playerDetail(db: Executor, handle: string, now: Date) {
  const [account] = await db
    .select({
      id: accounts.id,
      handle: accounts.handle,
      displayName: accounts.displayName,
      role: accounts.role,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.handle, handle));
  if (!account) return null;

  const issuer = alias(accounts, 'issuer');
  const lifter = alias(accounts, 'lifter');
  const reporter = alias(accounts, 'reporter');
  const resolver = alias(accounts, 'resolver');
  const inviteId = sql<string | null>`${auditLog.data}->>'inviteId'`;

  const [heroes, registration, sanctionRows, reportRows] = await Promise.all([
    db
      .select({
        name: characters.name,
        classId: characters.classId,
        level: characters.level,
        createdAt: characters.createdAt,
      })
      .from(characters)
      .where(eq(characters.accountId, account.id))
      .orderBy(asc(characters.createdAt), asc(characters.id)),
    db
      .select({ at: auditLog.createdAt, inviteId, note: inviteCodes.note })
      .from(auditLog)
      .leftJoin(inviteCodes, sql`${inviteCodes.id}::text = ${inviteId}`)
      .where(and(eq(auditLog.accountId, account.id), eq(auditLog.event, 'account.register')))
      .limit(1),
    db
      .select({
        s: sanctions,
        issuerHandle: issuer.handle,
        issuerName: issuer.displayName,
        lifterHandle: lifter.handle,
        lifterName: lifter.displayName,
      })
      .from(sanctions)
      .leftJoin(issuer, eq(issuer.id, sanctions.issuedBy))
      .leftJoin(lifter, eq(lifter.id, sanctions.liftedBy))
      .where(eq(sanctions.subjectId, account.id))
      .orderBy(desc(sanctions.createdAt), desc(sanctions.id)),
    db
      .select({
        r: reports,
        reporterHandle: reporter.handle,
        reporterName: reporter.displayName,
        resolverHandle: resolver.handle,
        resolverName: resolver.displayName,
      })
      .from(reports)
      .innerJoin(reporter, eq(reporter.id, reports.reporterId))
      .leftJoin(resolver, eq(resolver.id, reports.resolvedBy))
      // Ticket 4.11: reports about admins are handled outside the app (docs/SOCIAL.md), so an
      // admin's file (one's own included) never shows who reported them or why.
      .where(and(eq(reports.subjectId, account.id), sql`${account.role} <> 'admin'`))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(REPORTS_LIMIT + 1),
  ]);

  const reg = registration[0];
  const sanctionViews = sanctionRows.map(({ s, ...p }) => {
    const status = s.liftedAt
      ? ('lifted' as const)
      : s.expiresAt.getTime() > now.getTime()
        ? ('active' as const)
        : ('expired' as const);
    return {
      id: s.id,
      kind: s.kind,
      status,
      reason: s.reason,
      target: s.target ?? null,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      liftedAt: s.liftedAt?.toISOString() ?? null,
      liftReason: s.liftReason ?? null,
      issuedBy: ref(p.issuerHandle, p.issuerName),
      liftedBy: ref(p.lifterHandle, p.lifterName),
    };
  });
  const reportViews = reportRows.slice(0, REPORTS_LIMIT).map(({ r, ...p }) => ({
    id: r.id,
    target: r.target,
    reason: r.reason,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    reporter: { handle: p.reporterHandle, displayName: p.reporterName },
    resolvedBy: ref(p.resolverHandle, p.resolverName),
  }));

  return {
    handle: account.handle,
    displayName: account.displayName,
    role: account.role,
    createdAt: account.createdAt.toISOString(),
    registration: reg
      ? {
          at: reg.at.toISOString(),
          invite: reg.inviteId ? { id: reg.inviteId, note: reg.note ?? null } : null,
        }
      : null,
    characters: heroes.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
    sanctions: sanctionViews,
    reports: reportViews,
    reportsTruncated: reportRows.length > REPORTS_LIMIT,
    /** Whether an admin may act on this account in the moderator queue (rank below admin). */
    actionable:
      moderationDecision('admin', 'mute', { self: false, role: account.role }) === 'allowed',
  };
}

/** Moderators and admins, admins first, for the read-only roles list. */
export async function staffList(db: Executor) {
  const rows = await db
    .select({
      id: accounts.id,
      handle: accounts.handle,
      displayName: accounts.displayName,
      role: accounts.role,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(inArray(accounts.role, ['moderator', 'admin']))
    .orderBy(desc(sql`${accounts.role} = 'admin'`), asc(sql`lower(${accounts.displayName})`));
  const grants = rows.length
    ? await db
        .select({
          accountId: auditLog.accountId,
          at: sql<Date>`max(${auditLog.createdAt})`.mapWith(auditLog.createdAt),
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.event, 'role.grant'),
            inArray(
              auditLog.accountId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .groupBy(auditLog.accountId)
    : [];
  return rows.map((r) => {
    const g = grants.find((x) => x.accountId === r.id);
    return {
      handle: r.handle,
      displayName: r.displayName,
      role: r.role,
      accountCreatedAt: r.createdAt.toISOString(),
      grantedAt: g ? g.at.toISOString() : null,
    };
  });
}
