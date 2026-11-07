import { desc, eq } from 'drizzle-orm';
import { guildMessages, guilds, type Guild, type GuildMessage } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { membershipOf } from './guild-model.js';
import { isBlockedEitherWay } from './relations.js';

/**
 * The guild chat model (ticket 4.5, docs/SOCIAL.md "Guild chat"), shared by the chat routes, the
 * report resolver and the moderator queue. Internal ids in; players see message ids and handles.
 */

/** The report and `hide` key of a message or notice (internal). */
export function messageTargetKey(messageId: string): string {
  return `message:${messageId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A message with its guild (existing or disbanded), or null. */
export async function messageById(
  executor: Executor,
  id: string,
): Promise<{ message: GuildMessage; guild: Guild } | null> {
  if (!isMessageId(id)) return null;
  const [row] = await executor
    .select({ message: guildMessages, guild: guilds })
    .from(guildMessages)
    .innerJoin(guilds, eq(guilds.id, guildMessages.guildId))
    .where(eq(guildMessages.id, id));
  return row ?? null;
}

/**
 * The message as `viewerId` may reach it: a line in the chat of the viewer's own guild, by an
 * author neither side blocks. Anything else (another guild's line, a guild the viewer left, a
 * blocked author) is null, answered like an unknown message.
 */
export async function visibleMessage(
  executor: Executor,
  viewerId: string,
  id: string,
): Promise<{ message: GuildMessage; guild: Guild } | null> {
  const found = await messageById(executor, id);
  if (!found) return null;
  const mine = await membershipOf(executor, viewerId);
  if (!mine || mine.guild.id !== found.guild.id) return null;
  const author = found.message.authorId;
  if (author && (await isBlockedEitherWay(executor, viewerId, author))) return null;
  return found;
}

/** The newest `seq` of a guild's chat (0 when empty). */
export async function latestSeq(executor: Executor, guildId: string): Promise<number> {
  const [row] = await executor
    .select({ seq: guildMessages.seq })
    .from(guildMessages)
    .where(eq(guildMessages.guildId, guildId))
    .orderBy(desc(guildMessages.seq))
    .limit(1);
  return row?.seq ?? 0;
}
