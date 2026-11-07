import type { GuildRole } from '@worldforge/game-core';
import { guildMembers, guilds, type Guild } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';

let seq = 0;
const letters = (n: number) => {
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return s;
};

/**
 * A guild inserted directly (test stand-in for founding it; no gold), ticket 4.4. `leader` leads;
 * `members` join with the given roles.
 */
export async function insertGuild(
  db: Database,
  leaderId: string,
  {
    members = [],
    name,
    tag,
    now = new Date(),
  }: {
    members?: { accountId: string; role?: GuildRole }[];
    name?: string;
    tag?: string;
    now?: Date;
  } = {},
): Promise<Guild> {
  seq += 1;
  const [row] = await db
    .insert(guilds)
    .values({
      id: uuidv7(),
      name: name ?? `Company ${letters(seq).toLowerCase()}`,
      tag: tag ?? `T${letters(seq)}`.slice(0, 5),
      emblem: 'anvil',
      createdBy: leaderId,
      createdAt: now,
    })
    .returning();
  await db.insert(guildMembers).values([
    { accountId: leaderId, guildId: row!.id, role: 'leader', joinedAt: now },
    ...members.map((m) => ({
      accountId: m.accountId,
      guildId: row!.id,
      role: m.role ?? ('member' as const),
      joinedAt: now,
    })),
  ]);
  return row!;
}
