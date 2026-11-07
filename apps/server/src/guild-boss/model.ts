import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  guildBossStageOf,
  sumStageRewards,
  type GuildBossDefinition,
  type GuildBossWeek,
  type MaterialId,
} from '@worldforge/game-core';
import {
  guildBossAttempts,
  guildBossRewards,
  guildBossStreams,
  itemInstances,
  type Character,
  type GuildBossSnapshot,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';

/**
 * The guild boss model (ticket 4.9, docs/GUILD_BOSS.md). Locks, in order, for every write:
 * the account row (share, `assertSocialWriteAllowed`; attempts only) → the account's guild boss
 * lock (`lockGuildBossAccount`: one account's attempts and claims run one at a time, whatever
 * guild it is in) → the hero (`lockOwnedCharacter`, settles its farming) → the guild
 * (`lockGuild`; attempts only, the same lock every membership change takes).
 */

/** Inside a transaction: the account's guild boss lock (transaction-scoped advisory lock). */
export async function lockGuildBossAccount(tx: Executor, accountId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`guildboss:${accountId}`}, 0))`,
  );
}

/**
 * The account's server-only secret (created on its first attempt). Attempt `n` of week `W` fights
 * from `${secret}:${W}:${n}`: fixed the moment it is spent, unknown until then.
 */
export async function guildBossSecret(
  tx: Transaction,
  accountId: string,
  now: Date,
): Promise<string> {
  await tx
    .insert(guildBossStreams)
    .values({ accountId, seedSecret: randomBytes(16).toString('hex'), createdAt: now })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ seedSecret: guildBossStreams.seedSecret })
    .from(guildBossStreams)
    .where(eq(guildBossStreams.accountId, accountId));
  return row!.seedSecret;
}

export const attemptSeed = (secret: string, week: GuildBossWeek, attemptNo: number) =>
  `${secret}:${week.key}:${attemptNo}`;

/** The hero as it fights: level, XP and equipped items (the crypt's snapshot shape). */
export async function heroSnapshot(tx: Executor, hero: Character): Promise<GuildBossSnapshot> {
  const equipment = await tx
    .select({
      baseId: itemInstances.baseId,
      rarityId: itemInstances.rarityId,
      itemLevel: itemInstances.itemLevel,
      affixes: itemInstances.affixes,
      effectId: itemInstances.effectId,
      effectRoll: itemInstances.effectRoll,
      setId: itemInstances.setId,
      upgradeLevel: itemInstances.upgradeLevel,
      variant: itemInstances.variant,
    })
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, hero.id), isNotNull(itemInstances.equippedSlot)));
  return { classId: hero.classId, level: hero.level, xp: hero.experience, equipment };
}

/** Attempts the account made in a week (in any guild). */
export async function attemptsUsed(
  executor: Executor,
  accountId: string,
  week: string,
): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(guildBossAttempts)
    .where(and(eq(guildBossAttempts.accountId, accountId), eq(guildBossAttempts.week, week)));
  return row?.n ?? 0;
}

/** The accounts that fought for a guild in a week. */
export async function fightersOf(
  executor: Executor,
  guildId: string,
  week: string,
): Promise<Set<string>> {
  const rows = await executor
    .selectDistinct({ accountId: guildBossAttempts.accountId })
    .from(guildBossAttempts)
    .where(and(eq(guildBossAttempts.guildId, guildId), eq(guildBossAttempts.week, week)));
  return new Set(rows.map((r) => r.accountId).filter((id): id is string => id !== null));
}

export interface EarnedReward {
  accountId: string;
  stage: number;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
}

/**
 * Stage rewards when a guild reaches new stages (inside the attempt's transaction, under the
 * guild lock). Every current member gets a row per stage: `earned` if they already fought for the
 * guild this week, else `pending` (it turns `earned` with their first attempt for this guild this
 * week, `earnPendingRewards`). The primary key is per account, week and stage, so an account takes
 * each stage once a week whatever guild it is in: a `pending` row left in a former guild is moved
 * to the new one, an `earned` row is never touched. Returns the rows that became `earned`.
 */
export async function grantStageRewards(
  tx: Transaction,
  args: {
    guildId: string;
    week: string;
    boss: GuildBossDefinition;
    stages: readonly number[];
    memberIds: readonly string[];
    fighters: ReadonlySet<string>;
    now: Date;
  },
): Promise<EarnedReward[]> {
  const { guildId, week, boss, stages, memberIds, fighters, now } = args;
  if (stages.length === 0 || memberIds.length === 0) return [];
  const values = stages.flatMap((stage) => {
    const reward = sumStageRewards(boss, [stage]);
    return memberIds.map((accountId) => {
      const earned = fighters.has(accountId);
      return {
        accountId,
        week,
        stage,
        guildId,
        bossId: boss.id,
        status: earned ? ('earned' as const) : ('pending' as const),
        gold: reward.gold,
        materials: reward.materials,
        earnedAt: earned ? now : null,
        createdAt: now,
      };
    });
  });
  const rows = await tx
    .insert(guildBossRewards)
    .values(values)
    .onConflictDoUpdate({
      target: [guildBossRewards.accountId, guildBossRewards.week, guildBossRewards.stage],
      set: {
        guildId: sql`excluded.guild_id`,
        bossId: sql`excluded.boss_id`,
        status: sql`excluded.status`,
        gold: sql`excluded.gold`,
        materials: sql`excluded.materials`,
        earnedAt: sql`excluded.earned_at`,
      },
      setWhere: sql`${guildBossRewards.status} = 'pending'`,
    })
    .returning();
  return rows
    .filter((r) => r.status === 'earned')
    .map((r) => ({ accountId: r.accountId, stage: r.stage, gold: r.gold, materials: r.materials }));
}

/** The attacker's first attempt for its guild this week: its `pending` stages become `earned`. */
export async function earnPendingRewards(
  tx: Transaction,
  accountId: string,
  guildId: string,
  week: string,
  now: Date,
): Promise<EarnedReward[]> {
  const rows = await tx
    .update(guildBossRewards)
    .set({ status: 'earned', earnedAt: now })
    .where(
      and(
        eq(guildBossRewards.accountId, accountId),
        eq(guildBossRewards.guildId, guildId),
        eq(guildBossRewards.week, week),
        eq(guildBossRewards.status, 'pending'),
      ),
    )
    .returning();
  return rows.map((r) => ({
    accountId: r.accountId,
    stage: r.stage,
    gold: r.gold,
    materials: r.materials,
  }));
}

/**
 * Stages newly reached when a guild's week, with `recorded` stages already reached, has `total`
 * (ticket B.3). Reads the stored stage instead of the total before the attempt, so a threshold
 * lowered mid-week (a balance change) is paid at the guild's next attempt instead of never.
 */
export function stagesAfter(boss: GuildBossDefinition, recorded: number, total: number): number[] {
  const to = guildBossStageOf(boss, total);
  return Array.from({ length: Math.max(0, to - recorded) }, (_, i) => recorded + 1 + i);
}
