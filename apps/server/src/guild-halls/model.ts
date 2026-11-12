import { and, eq, sql } from 'drizzle-orm';
import {
  PLAIN_HALL,
  TREASURY_MATERIALS,
  type GuildHallDisplay,
  type TreasuryAmounts,
  type TreasuryMaterial,
  type TreasuryResource,
} from '@worldforge/game-core';
import {
  guildHallDisplays,
  guildHallUpgrades,
  guildTreasuries,
  guildTreasuryGifts,
  type Guild,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';

/**
 * Guild treasuries and halls (ticket 8.4, docs/GUILD_HALLS.md). Every change runs under the guild's
 * lock (`lockGuild`), the lock every membership change takes, so a gift racing a kick, a leave or a
 * disband lands wholly before or after it, and the daily caps are exact.
 */

export interface Treasury {
  gold: number;
  materials: Partial<Record<TreasuryMaterial, number>>;
}

export const EMPTY_TREASURY: Treasury = { gold: 0, materials: {} };

/** The guild's treasury (`for update` inside a transaction that holds the guild lock). */
export async function treasuryOf(
  executor: Executor,
  guildId: string,
  { forUpdate = false } = {},
): Promise<Treasury> {
  const q = executor.select().from(guildTreasuries).where(eq(guildTreasuries.guildId, guildId));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) return { gold: 0, materials: {} };
  return { gold: Number(row.gold), materials: { ...row.materials } };
}

export function treasuryAmounts(t: Treasury): TreasuryAmounts {
  return { gold: t.gold, ...t.materials };
}

export async function writeTreasury(tx: Transaction, guildId: string, t: Treasury, now: Date) {
  const materials = Object.fromEntries(
    TREASURY_MATERIALS.filter((m) => (t.materials[m] ?? 0) > 0).map((m) => [m, t.materials[m]!]),
  );
  await tx
    .insert(guildTreasuries)
    .values({ guildId, gold: t.gold, materials, updatedAt: now })
    .onConflictDoUpdate({
      target: guildTreasuries.guildId,
      set: { gold: t.gold, materials, updatedAt: now },
    });
}

/** What the account gave the guild's treasury on `day`, per resource. */
export async function givenToday(
  executor: Executor,
  guildId: string,
  accountId: string,
  day: string,
): Promise<TreasuryAmounts> {
  const rows = await executor
    .select({ resource: guildTreasuryGifts.resource, amount: guildTreasuryGifts.amount })
    .from(guildTreasuryGifts)
    .where(
      and(
        eq(guildTreasuryGifts.guildId, guildId),
        eq(guildTreasuryGifts.accountId, accountId),
        eq(guildTreasuryGifts.day, day),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.resource, Number(r.amount)]));
}

export async function addGift(
  tx: Transaction,
  guildId: string,
  accountId: string,
  day: string,
  accepted: TreasuryAmounts,
) {
  for (const [resource, amount] of Object.entries(accepted) as [TreasuryResource, number][]) {
    await tx
      .insert(guildTreasuryGifts)
      .values({ guildId, accountId, day, resource, amount })
      .onConflictDoUpdate({
        target: [
          guildTreasuryGifts.guildId,
          guildTreasuryGifts.accountId,
          guildTreasuryGifts.day,
          guildTreasuryGifts.resource,
        ],
        set: { amount: sql`${guildTreasuryGifts.amount} + excluded.amount` },
      });
  }
}

export async function ownedUpgrades(executor: Executor, guildId: string) {
  return executor.select().from(guildHallUpgrades).where(eq(guildHallUpgrades.guildId, guildId));
}

export async function hallDisplayOf(
  executor: Executor,
  guildIds: readonly string[],
): Promise<Map<string, GuildHallDisplay>> {
  const out = new Map<string, GuildHallDisplay>();
  if (guildIds.length === 0) return out;
  const rows = await executor
    .select()
    .from(guildHallDisplays)
    .where(
      sql`${guildHallDisplays.guildId} = any(${`{${[...new Set(guildIds)].join(',')}}`}::uuid[])`,
    );
  for (const r of rows) {
    out.set(r.guildId, {
      hallBanner: r.hallBanner,
      crestFrame: r.crestFrame,
      backdrop: r.backdrop,
      titleColour: r.titleColour,
    });
  }
  return out;
}

export const plainHall = (): GuildHallDisplay => ({ ...PLAIN_HALL });

/**
 * Inside `disbandGuildTx` (the guild lock held): the treasury is forfeit. Nothing is refunded to
 * anyone (shown before every gift); what it held is audited (`guild.treasury_forfeit`) and counted
 * (`guild_treasury.forfeit`), so the reconciliation still balances.
 */
export async function forfeitTreasuryTx(
  tx: Transaction,
  guild: Pick<Guild, 'id'>,
  by: { accountId: string; moderator: boolean },
  now: Date,
): Promise<Treasury> {
  const t = await treasuryOf(tx, guild.id, { forUpdate: true });
  const units = Object.values(t.materials).reduce((s, n) => s + (n ?? 0), 0);
  if (t.gold === 0 && units === 0) return t;
  await writeTreasury(tx, guild.id, EMPTY_TREASURY, now);
  await writeAudit(tx, {
    event: 'guild.treasury_forfeit',
    accountId: by.accountId,
    data: { guildId: guild.id, gold: t.gold, materials: t.materials, byModerator: by.moderator },
  });
  recordTelemetry(tx, now, [{ metric: 'guild_treasury.forfeit', amount: t.gold }]);
  return t;
}
