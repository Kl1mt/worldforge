import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { HANDLE_RE, nameSkeleton, type GuildRole } from '@worldforge/game-core';
import {
  guildApplications,
  guildInvites,
  guildMembers,
  guilds,
  type Guild,
  type GuildMember,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import type { RelationEvents } from './relations.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';

/**
 * The guild model (ticket 4.4, docs/SOCIAL.md "Guilds"): the reusable helpers other features ask
 * (profiles, presence, moderation; guild chat 4.5 and the guild boss 4.7 later). All take internal
 * ids; players only ever see guild and account handles.
 *
 * Locking: a membership row changes only under its guild's lock (`lockGuild`), and a join also
 * under the joiner's social lock (`lockSocialAccounts`), so "one guild per account" and the member
 * cap are exact. Lock order everywhere: the actor's account row (share, `socialWrite`) → social
 * locks (sorted) → the guild lock. Moderators: actor (share) → report → subject (update) → guild.
 */

/** Inside a transaction: the guild's lock (transaction-scoped advisory lock). */
export async function lockGuild(tx: Executor, guildId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`guild:${guildId}`}, 0))`);
}

/** The account's membership and its guild, if any. */
export async function membershipOf(
  executor: Executor,
  accountId: string,
): Promise<{ guild: Guild; member: GuildMember } | null> {
  const [row] = await executor
    .select({ guild: guilds, member: guildMembers })
    .from(guildMembers)
    .innerJoin(guilds, eq(guilds.id, guildMembers.guildId))
    .where(eq(guildMembers.accountId, accountId));
  return row ?? null;
}

/** A guild that exists (not disbanded) by its public handle. */
export async function guildByHandle(executor: Executor, handle: string): Promise<Guild | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const [row] = await executor
    .select()
    .from(guilds)
    .where(and(eq(guilds.handle, handle), isNull(guilds.disbandedAt)));
  return row ?? null;
}

export async function guildMembersOf(executor: Executor, guildId: string) {
  return executor.select().from(guildMembers).where(eq(guildMembers.guildId, guildId));
}

/** The guild's leader's account id (null only for a disbanded guild). */
export async function guildLeaderId(executor: Executor, guildId: string): Promise<string | null> {
  const [row] = await executor
    .select({ accountId: guildMembers.accountId })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.role, 'leader')));
  return row?.accountId ?? null;
}

/** The account's guildmates (not including the account). */
export async function guildmateIds(executor: Executor, accountId: string): Promise<string[]> {
  const mine = await membershipOf(executor, accountId);
  if (!mine) return [];
  const rows = await guildMembersOf(executor, mine.guild.id);
  return rows.map((r) => r.accountId).filter((id) => id !== accountId);
}

/** Whether two different accounts are in the same guild. */
export async function areGuildmates(executor: Executor, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = await executor
    .select({ guildId: guildMembers.guildId })
    .from(guildMembers)
    .where(inArray(guildMembers.accountId, [a, b]));
  return rows.length === 2 && rows[0]!.guildId === rows[1]!.guildId;
}

export async function memberCount(executor: Executor, guildId: string): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(guildMembers)
    .where(eq(guildMembers.guildId, guildId));
  return row?.n ?? 0;
}

/** Guild names and tags as they are compared for uniqueness. */
export const nameKey = (name: string) => name.toLowerCase();

/**
 * Inside a transaction: takes the name's and the tag's locks and refuses them if a guild that
 * exists (other than `exceptGuildId`) uses either: `409 guild_name_taken` / `409 guild_tag_taken`.
 * Two founders racing for one name serialise here; the partial unique indexes are the backstop.
 */
export async function claimGuildName(
  tx: Executor,
  name: string,
  tag: string,
  exceptGuildId?: string,
): Promise<void> {
  const keys = [`guildname:${nameKey(name)}`, `guildtag:${tag}`].sort();
  for (const k of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
  }
  const taken = await tx
    .select({ id: guilds.id, name: guilds.name, tag: guilds.tag })
    .from(guilds)
    .where(
      and(
        isNull(guilds.disbandedAt),
        sql`(lower(${guilds.name}) = ${nameKey(name)} or ${guilds.tag} = ${tag})`,
      ),
    );
  const other = taken.filter((g) => g.id !== exceptGuildId);
  if (other.some((g) => nameKey(g.name) === nameKey(name))) {
    throw new ApiError(409, 'guild_name_taken', 'A guild of that name already exists.', {
      fields: { name: 'A guild of that name already exists.' },
    });
  }
  if (other.some((g) => g.tag === tag)) {
    throw new ApiError(409, 'guild_tag_taken', 'Another guild carries that tag.', {
      fields: { tag: 'Another guild carries that tag.' },
    });
  }
}

/**
 * Disbands a guild under its lock: frees the name, removes every member, invite and application,
 * and writes `guild.disband` (with the members, so their history can be read back). Called by the
 * leader's disband and a moderator's `disbandGuild`.
 */
export async function disbandGuildTx(
  tx: Transaction,
  guild: Guild,
  by: { accountId: string; moderator: boolean; reason: string | null; reportId?: string },
  now: Date,
  relationEvents?: RelationEvents,
): Promise<{ members: { accountId: string; role: GuildRole }[] }> {
  const members = await tx
    .delete(guildMembers)
    .where(eq(guildMembers.guildId, guild.id))
    .returning({ accountId: guildMembers.accountId, role: guildMembers.role });
  await tx.delete(guildInvites).where(eq(guildInvites.guildId, guild.id));
  await tx.delete(guildApplications).where(eq(guildApplications.guildId, guild.id));
  await tx.update(guilds).set({ disbandedAt: now }).where(eq(guilds.id, guild.id));
  await writeAudit(tx, {
    event: 'guild.disband',
    accountId: by.accountId,
    data: {
      guildId: guild.id,
      name: guild.name,
      tag: guild.tag,
      members: members.map((m) => m.accountId),
      byModerator: by.moderator,
      reason: by.reason,
      ...(by.reportId ? { reportId: by.reportId } : {}),
    },
  });
  // Ticket T.5: offers that relied on the guild relation are voided.
  await relationEvents?.emit(
    { accountIds: members.map((m) => m.accountId), cause: 'guild_disband', at: now },
    tx,
  );
  return { members };
}

/**
 * A moderator's forced rename (ticket 4.4): the name and tag become placeholders at once
 * ("Nameless Company 482913", "X4821"), and the leader must choose new ones (not the old name).
 * Audited on the leader's account (`guild.force_rename`, the moderator in the data), like a
 * sanction.
 */
export async function forceRenameGuildTx(
  tx: Transaction,
  guild: Guild,
  by: { moderatorId: string; leaderId: string; reason: string; reportId: string },
): Promise<{ name: string; tag: string }> {
  let placeholder: { name: string; tag: string } | null = null;
  for (let i = 0; i < 20 && !placeholder; i++) {
    const name = `Nameless Company ${randomInt(100_000, 1_000_000)}`;
    const tag = `X${randomInt(1000, 10_000)}`;
    const [taken] = await tx
      .select({ id: guilds.id })
      .from(guilds)
      .where(
        and(
          isNull(guilds.disbandedAt),
          sql`(lower(${guilds.name}) = ${nameKey(name)} or ${guilds.tag} = ${tag})`,
        ),
      )
      .limit(1);
    if (!taken) placeholder = { name, tag };
  }
  if (!placeholder) throw new Error('no free placeholder guild name');
  await tx
    .update(guilds)
    .set({
      ...placeholder,
      nameSkeleton: nameSkeleton(placeholder.name),
      renameRequired: true,
      renameReason: by.reason,
      // A second forced rename before the leader renamed keeps the first offending name.
      renamedFrom: guild.renameRequired ? guild.renamedFrom : guild.name,
    })
    .where(eq(guilds.id, guild.id));
  await writeAudit(tx, {
    event: 'guild.force_rename',
    accountId: by.leaderId,
    data: {
      guildId: guild.id,
      issuedBy: by.moderatorId,
      reason: by.reason,
      reportId: by.reportId,
      from: { name: guild.name, tag: guild.tag },
      placeholder,
    },
  });
  return placeholder;
}

/** The report target key of a guild (internal). */
export function guildTargetKey(guildId: string): string {
  return `guild:${guildId}`;
}

/** The guild an account is in, as other players may see it (plus its internal id), or null. */
export async function publicGuildOf(executor: Executor, accountId: string) {
  const mine = await membershipOf(executor, accountId);
  if (!mine) return null;
  const g = mine.guild;
  return {
    id: g.id,
    handle: g.handle,
    name: g.name,
    tag: g.tag,
    emblem: g.emblem,
    role: mine.member.role,
  };
}

/**
 * Ticket 4.11: when one player blocks another, the guild offers between them that the block hides
 * are dropped, so they no longer fill anyone's caps unseen: invites from one to the other, invites
 * from a guild either leads to the other, and applications by one to a guild the other leads (a
 * guild is its leader's, docs/SOCIAL.md "Blocks"). An application an officer can no longer see
 * stays: the guild's other officers can still answer it. Runs under both players' social locks
 * (the block's), which every invite between them also takes. Returns how many rows went.
 */
export async function dropGuildOffersBetween(
  tx: Transaction,
  a: string,
  b: string,
): Promise<{ invites: number; applications: number }> {
  const ledBy = (id: string) =>
    tx
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(and(eq(guildMembers.accountId, id), eq(guildMembers.role, 'leader')));
  const [aLeads, bLeads] = await Promise.all([ledBy(a), ledBy(b)]);
  const guildsOf = (rows: { guildId: string }[]) => rows.map((r) => r.guildId);
  const pair = (x: string, y: string, ledByY: string[]) =>
    and(
      eq(guildInvites.accountId, x),
      ledByY.length
        ? sql`(${guildInvites.invitedBy} = ${y} or ${inArray(guildInvites.guildId, ledByY)})`
        : eq(guildInvites.invitedBy, y),
    );
  const invites = await tx
    .delete(guildInvites)
    .where(sql`(${pair(a, b, guildsOf(bLeads))}) or (${pair(b, a, guildsOf(aLeads))})`)
    .returning({ accountId: guildInvites.accountId });
  const applied = (x: string, ledByY: string[]) =>
    ledByY.length
      ? and(eq(guildApplications.accountId, x), inArray(guildApplications.guildId, ledByY))
      : undefined;
  const conditions = [applied(a, guildsOf(bLeads)), applied(b, guildsOf(aLeads))].filter(
    (c) => c !== undefined,
  );
  const applications = conditions.length
    ? await tx
        .delete(guildApplications)
        .where(
          conditions.length === 1 ? conditions[0] : sql`(${conditions[0]}) or (${conditions[1]})`,
        )
        .returning({ accountId: guildApplications.accountId })
    : [];
  return { invites: invites.length, applications: applications.length };
}
