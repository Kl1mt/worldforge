import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  getEnemy,
  getGuildBoss,
  guildBossDecision,
  guildBossOfWeek,
  guildBossStageOf,
  guildBossWeek,
  isGuildBossId,
  simulateGuildBossAttempt,
  type DungeonEvent,
  type GuildBossAction,
  type GuildBossDecision,
  type GuildBossDefinition,
  type GuildBossFacts,
  type GuildStanding,
  type MaterialId,
} from '@worldforge/game-core';
import {
  characters,
  guildBossAttempts,
  guildBossRewards,
  guildBossStages,
  guildBossWeeks,
  guilds,
  type Guild,
} from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import { changeGold } from '../economy/shared.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { lockOwnedCharacter } from '../inventory/routes.js';
import { changeMaterialsTx } from '../materials/store.js';
import { awardAchievements } from '../achievements/award.js';
import { recordTelemetry } from '../telemetry/record.js';
import { goldIn, materialCounts } from '../telemetry/counts.js';
import { guildMembersOf, lockGuild, membershipOf } from '../social/guild-model.js';
import { blockedEitherWay } from '../social/relations.js';
import { people } from '../social/guilds.js';
import { assertSocialWriteAllowed } from '../social/social-write.js';
import {
  attemptSeed,
  attemptsUsed,
  earnPendingRewards,
  fightersOf,
  grantStageRewards,
  guildBossSecret,
  heroSnapshot,
  lockGuildBossAccount,
  stagesAfter,
  type EarnedReward,
} from './model.js';

/**
 * The weekly guild boss (ticket 4.9, docs/GUILD_BOSS.md). `GET /guild/boss` shows the week, the
 * boss, the player's attempts and unclaimed rewards and, for a member, the guild's total, stages
 * and damage board. `POST /guild/boss/attempts` spends one of the account's weekly attempts with a
 * hero (an `Idempotency-Key` value operation: the fight is decided by the server-only stream and
 * the hero's snapshot, the guild's total and stage rewards are written in the same transaction).
 * `POST /guild/boss/claim` pays the account's earned rewards to a hero.
 */

export interface GuildBossStageView {
  stage: number;
  name: string;
  threshold: number;
  reward: { gold: number; materials: Partial<Record<MaterialId, number>> };
}

export interface GuildBossInfoView {
  id: string;
  name: string;
  description: string;
  /** Art: the enemy it is built from. */
  assetId: string;
  levelOffset: number;
  fightMs: number;
  minLevel: number;
  attemptDamageCap: number;
  stages: GuildBossStageView[];
}

export interface GuildBossMyAttemptView {
  attemptNo: number;
  damage: number;
  counted: number;
  end: 'fell' | 'endured';
  heroName: string | null;
  /** Fought for the guild the player is in now. */
  forThisGuild: boolean;
  at: string;
}

export interface GuildBossRewardView {
  week: string;
  stage: number;
  stageName: string;
  bossName: string;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
  /** The guild it was earned with (it may have been left since). */
  guildName: string;
  guildTag: string;
}

export interface GuildBossBoardRow {
  rank: number;
  /** Null for a former member, a player blocked either way, or a hidden name. */
  player: { handle: string; displayName: string | null } | null;
  you: boolean;
  former: boolean;
  blocked: boolean;
  damage: number;
  attempts: number;
}

export interface GuildBossGuildView {
  handle: string;
  name: string;
  tag: string;
  role: GuildStanding;
  total: number;
  stage: number;
  attempts: number;
  reached: { stage: number; reachedAt: string }[];
  board: GuildBossBoardRow[];
}

export interface GuildBossStateResponse {
  now: string;
  week: { key: string; startsAt: string; endsAt: string };
  boss: GuildBossInfoView;
  attemptsPerWeek: number;
  me: {
    attemptsUsed: number;
    attemptsLeft: number;
    attempts: GuildBossMyAttemptView[];
    /** Earned and not claimed yet (any week, any guild). */
    rewards: GuildBossRewardView[];
    /** Stages the guild reached this week that turn `earned` with the player's first attempt. */
    pendingStages: number[];
  };
  /** Null when the player is in no guild. */
  guild: GuildBossGuildView | null;
}

export interface GuildBossAttemptView {
  id: string;
  week: string;
  attemptNo: number;
  bossId: string;
  bossLevel: number;
  heroName: string;
  classId: string;
  level: number;
  damage: number;
  counted: number;
  end: 'fell' | 'endured';
  durationMs: number;
  enrageAtMs: number;
  startHealth: number;
  /** The fight, for the replay (`t` ms from the start). */
  events: DungeonEvent[];
  /** Stages this attempt broke for the guild. */
  newStages: number[];
  /** Stages whose reward this attempt earned for the player. */
  earnedStages: number[];
}

export interface GuildBossAttemptResponse {
  attempt: GuildBossAttemptView;
  state: GuildBossStateResponse;
}

export interface GuildBossClaimResponse {
  claimed: {
    gold: number;
    materials: Partial<Record<MaterialId, number>>;
    rewards: { week: string; stage: number }[];
  };
  character: CharacterView;
}

const heroBody = {
  type: 'object',
  additionalProperties: false,
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

function decide(
  standing: GuildStanding,
  action: GuildBossAction,
  boss?: GuildBossDefinition,
  facts?: GuildBossFacts,
): void {
  const d: GuildBossDecision = guildBossDecision(standing, action, boss, facts);
  if (d !== 'allowed') throw new ApiError(d.status, d.code, d.message);
}

export function bossInfo(boss: GuildBossDefinition): GuildBossInfoView {
  return {
    id: boss.id,
    name: boss.name,
    description: boss.description,
    assetId: getEnemy(boss.enemyId).assetId,
    levelOffset: boss.levelOffset,
    fightMs: boss.fightMs,
    minLevel: boss.minLevel,
    attemptDamageCap: boss.attemptDamageCap,
    stages: boss.stages.map((s) => ({
      stage: s.stage,
      name: s.name,
      threshold: s.threshold,
      reward: { gold: s.reward.gold, materials: { ...s.reward.materials } },
    })),
  };
}

const bossNameOf = (id: string) => (isGuildBossId(id) ? getGuildBoss(id).name : id);
const stageNameOf = (id: string, stage: number) =>
  (isGuildBossId(id) ? getGuildBoss(id).stages.find((s) => s.stage === stage)?.name : null) ??
  `Stage ${stage}`;

/** The guild's board for a week: everyone who fought for it, best first. */
async function guildView(
  executor: Executor,
  viewerId: string,
  guild: Guild,
  role: GuildStanding,
  week: string,
  now: Date,
): Promise<GuildBossGuildView> {
  const [weekRow] = await executor
    .select()
    .from(guildBossWeeks)
    .where(and(eq(guildBossWeeks.guildId, guild.id), eq(guildBossWeeks.week, week)));
  const reached = await executor
    .select({ stage: guildBossStages.stage, reachedAt: guildBossStages.reachedAt })
    .from(guildBossStages)
    .where(and(eq(guildBossStages.guildId, guild.id), eq(guildBossStages.week, week)))
    .orderBy(asc(guildBossStages.stage));
  const sums = await executor
    .select({
      accountId: guildBossAttempts.accountId,
      damage: sql<number>`sum(${guildBossAttempts.counted})::int`,
      attempts: sql<number>`count(*)::int`,
    })
    .from(guildBossAttempts)
    .where(and(eq(guildBossAttempts.guildId, guild.id), eq(guildBossAttempts.week, week)))
    .groupBy(guildBossAttempts.accountId);
  const members = new Set((await guildMembersOf(executor, guild.id)).map((m) => m.accountId));
  const ids = sums.map((s) => s.accountId).filter((id): id is string => id !== null);
  const [byId, blocked] = await Promise.all([
    people(executor, ids, now),
    blockedEitherWay(executor, viewerId, ids),
  ]);
  const board = sums
    .map((s) => {
      const id = s.accountId;
      const former = id === null || !members.has(id);
      const isBlocked = id !== null && id !== viewerId && blocked.has(id);
      const p = id && !former && !isBlocked ? byId.get(id) : undefined;
      return {
        player: p ? { handle: p.handle, displayName: p.displayName } : null,
        you: id === viewerId,
        former,
        blocked: isBlocked,
        damage: s.damage,
        attempts: s.attempts,
      };
    })
    .sort((a, b) => b.damage - a.damage || Number(b.you) - Number(a.you))
    .map((row, i) => ({ rank: i + 1, ...row }));
  return {
    handle: guild.handle,
    name: guild.name,
    tag: guild.tag,
    role,
    total: weekRow?.total ?? 0,
    stage: weekRow?.stage ?? 0,
    attempts: weekRow?.attempts ?? 0,
    reached: reached.map((r) => ({ stage: r.stage, reachedAt: r.reachedAt.toISOString() })),
    board,
  };
}

export async function guildBossState(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<GuildBossStateResponse> {
  const week = guildBossWeek(now.getTime());
  const boss = guildBossOfWeek(week);
  const mine = await membershipOf(executor, accountId);
  const standing: GuildStanding = mine?.member.role ?? 'none';
  const attempts = await executor
    .select({
      attemptNo: guildBossAttempts.attemptNo,
      damage: guildBossAttempts.damage,
      counted: guildBossAttempts.counted,
      end: guildBossAttempts.end,
      guildId: guildBossAttempts.guildId,
      createdAt: guildBossAttempts.createdAt,
      heroName: characters.name,
    })
    .from(guildBossAttempts)
    .leftJoin(characters, eq(characters.id, guildBossAttempts.characterId))
    .where(and(eq(guildBossAttempts.accountId, accountId), eq(guildBossAttempts.week, week.key)))
    .orderBy(asc(guildBossAttempts.attemptNo));
  const rewards = await executor
    .select({ reward: guildBossRewards, guildName: guilds.name, guildTag: guilds.tag })
    .from(guildBossRewards)
    .innerJoin(guilds, eq(guilds.id, guildBossRewards.guildId))
    .where(
      and(
        eq(guildBossRewards.accountId, accountId),
        eq(guildBossRewards.status, 'earned'),
        isNull(guildBossRewards.claimedAt),
      ),
    )
    .orderBy(desc(guildBossRewards.week), asc(guildBossRewards.stage));
  const pending = mine
    ? await executor
        .select({ stage: guildBossRewards.stage })
        .from(guildBossRewards)
        .where(
          and(
            eq(guildBossRewards.accountId, accountId),
            eq(guildBossRewards.week, week.key),
            eq(guildBossRewards.guildId, mine.guild.id),
            eq(guildBossRewards.status, 'pending'),
          ),
        )
        .orderBy(asc(guildBossRewards.stage))
    : [];
  const used = attempts.length;
  return {
    now: now.toISOString(),
    week: {
      key: week.key,
      startsAt: new Date(week.startMs).toISOString(),
      endsAt: new Date(week.endMs).toISOString(),
    },
    boss: bossInfo(boss),
    attemptsPerWeek: GUILD_BOSS_ATTEMPTS_PER_WEEK,
    me: {
      attemptsUsed: used,
      attemptsLeft: Math.max(0, GUILD_BOSS_ATTEMPTS_PER_WEEK - used),
      attempts: attempts.map((a) => ({
        attemptNo: a.attemptNo,
        damage: a.damage,
        counted: a.counted,
        end: a.end as 'fell' | 'endured',
        heroName: a.heroName,
        forThisGuild: mine !== null && a.guildId === mine.guild.id,
        at: a.createdAt.toISOString(),
      })),
      rewards: rewards.map(({ reward: r, guildName, guildTag }) => ({
        week: r.week,
        stage: r.stage,
        stageName: stageNameOf(r.bossId, r.stage),
        bossName: bossNameOf(r.bossId),
        gold: r.gold,
        materials: r.materials,
        guildName,
        guildTag,
      })),
      pendingStages: pending.map((p) => p.stage),
    },
    guild:
      mine && guildBossDecision(standing, 'view') === 'allowed'
        ? await guildView(executor, accountId, mine.guild, standing, week.key, now)
        : null,
  };
}

const sumBundles = (rows: readonly { materials: Partial<Record<MaterialId, number>> }[]) => {
  const out: Partial<Record<MaterialId, number>> = {};
  for (const r of rows)
    for (const [m, n] of Object.entries(r.materials) as [MaterialId, number][])
      out[m] = (out[m] ?? 0) + n;
  return out;
};

export async function registerGuildBoss(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get('/guild/boss', { preHandler: app.requireAccount }, async (request) =>
    guildBossState(app.db, request.auth!.account.id, activity.now()),
  );

  // Fight the boss once with a hero of the account (any hero, not only the active one).
  app.post(
    '/guild/boss/attempts',
    { preHandler: app.requireAccount, schema: { body: heroBody } },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const { characterId } = request.body as { characterId: string };
      app.socialWriteLimit(me, reply);
      return idempotentTransaction<GuildBossAttemptResponse>(
        app,
        request,
        reply,
        { now: activity.now, status: 201 },
        async (tx) => {
          const now = activity.now();
          await assertSocialWriteAllowed(tx, me, 'guildBossAttempt', app.authNow());
          await lockGuildBossAccount(tx, me);
          const hero = await lockOwnedCharacter(tx, me, characterId, activity);
          // Membership is read under the guild's lock (a kick or leave racing the attempt lands
          // before it, and the attempt is refused, or after it, and the damage counted).
          const first = await membershipOf(tx, me);
          if (first) await lockGuild(tx, first.guild.id);
          const mine = first ? await membershipOf(tx, me) : null;
          const standing: GuildStanding =
            mine && mine.guild.id === first?.guild.id ? mine.member.role : 'none';
          const week = guildBossWeek(now.getTime());
          const boss = guildBossOfWeek(week);
          const used = await attemptsUsed(tx, me, week.key);
          decide(standing, 'attempt', boss, { attemptsUsed: used, heroLevel: hero.level });
          const guild = mine!.guild;

          const foughtBefore = (await fightersOf(tx, guild.id, week.key)).has(me);
          const attemptNo = used + 1;
          const snapshot = await heroSnapshot(tx, hero);
          const secret = await guildBossSecret(tx, me, now);
          const fight = simulateGuildBossAttempt({
            bossId: boss.id,
            character: { classId: snapshot.classId, level: snapshot.level },
            equipment: snapshot.equipment,
            seed: attemptSeed(secret, week, attemptNo),
          });
          const id = uuidv7();
          await tx.insert(guildBossAttempts).values({
            id,
            accountId: me,
            week: week.key,
            attemptNo,
            guildId: guild.id,
            characterId: hero.id,
            bossId: boss.id,
            snapshot,
            damage: fight.damage,
            counted: fight.counted,
            end: fight.end,
            durationMs: fight.durationMs,
            createdAt: now,
          });
          // The shared counter, in the same transaction (exact under concurrent attempts).
          const [counter] = await tx
            .insert(guildBossWeeks)
            .values({
              guildId: guild.id,
              week: week.key,
              bossId: boss.id,
              total: fight.counted,
              attempts: 1,
              // Recorded below with the stages this attempt broke.
              stage: 0,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [guildBossWeeks.guildId, guildBossWeeks.week],
              set: {
                total: sql`${guildBossWeeks.total} + excluded.total`,
                attempts: sql`${guildBossWeeks.attempts} + 1`,
                updatedAt: now,
              },
            })
            .returning();
          const total = counter!.total;
          // From the stage recorded so far (0 for the week's first attempt): ticket B.3.
          const newStages = stagesAfter(boss, counter!.stage, total);
          if (newStages.length > 0) {
            await tx
              .update(guildBossWeeks)
              .set({ stage: guildBossStageOf(boss, total) })
              .where(and(eq(guildBossWeeks.guildId, guild.id), eq(guildBossWeeks.week, week.key)));
            await tx.insert(guildBossStages).values(
              newStages.map((stage) => ({
                guildId: guild.id,
                week: week.key,
                stage,
                reachedAt: now,
                attemptId: id,
              })),
            );
          }

          // Rewards: the attacker's waiting stages (first attempt for this guild this week), then
          // the stages this attempt broke, for every member (earned if they fought, else pending).
          const earned: EarnedReward[] = foughtBefore
            ? []
            : await earnPendingRewards(tx, me, guild.id, week.key, now);
          if (newStages.length > 0) {
            const memberIds = (await guildMembersOf(tx, guild.id)).map((m) => m.accountId);
            const fighters = await fightersOf(tx, guild.id, week.key);
            earned.push(
              ...(await grantStageRewards(tx, {
                guildId: guild.id,
                week: week.key,
                boss,
                stages: newStages,
                memberIds,
                fighters,
                now,
              })),
            );
          }

          await writeAudit(tx, {
            event: 'guild_boss.attempt',
            accountId: me,
            characterId: hero.id,
            data: {
              attemptId: id,
              guildId: guild.id,
              week: week.key,
              attemptNo,
              bossId: boss.id,
              level: snapshot.level,
              damage: fight.damage,
              counted: fight.counted,
              end: fight.end,
              total,
              newStages,
            },
          });
          for (const stage of newStages) {
            await writeAudit(tx, {
              event: 'guild_boss.stage',
              accountId: me,
              data: { guildId: guild.id, week: week.key, bossId: boss.id, stage, total },
            });
          }
          // One `guild_boss.earn` per account that earned something here, and its achievements.
          const byAccount = new Map<string, EarnedReward[]>();
          for (const e of earned)
            byAccount.set(e.accountId, [...(byAccount.get(e.accountId) ?? []), e]);
          for (const [accountId, rows] of byAccount) {
            const stages = rows.map((r) => r.stage).sort((a, b) => a - b);
            await writeAudit(tx, {
              event: 'guild_boss.earn',
              accountId,
              data: {
                guildId: guild.id,
                week: week.key,
                bossId: boss.id,
                stages,
                gold: rows.reduce((s, r) => s + r.gold, 0),
                materials: sumBundles(rows),
                byAttemptId: id,
              },
            });
            await awardAchievements(
              tx,
              {
                accountId,
                characterId: accountId === me ? hero.id : null,
                now,
                source: 'live',
              },
              { guildBossStage: Math.max(...stages) },
            );
          }
          recordTelemetry(tx, now, [
            { metric: 'guild_boss.attempt', dims: [boss.id, fight.end], amount: fight.counted },
            ...newStages.map((stage) => ({
              metric: 'guild_boss.stage' as const,
              dims: [boss.id, String(stage)],
            })),
          ]);
          return {
            attempt: {
              id,
              week: week.key,
              attemptNo,
              bossId: boss.id,
              bossLevel: fight.bossLevel,
              heroName: hero.name,
              classId: hero.classId,
              level: snapshot.level,
              damage: fight.damage,
              counted: fight.counted,
              end: fight.end,
              durationMs: fight.durationMs,
              enrageAtMs: fight.enrageAtMs,
              startHealth: fight.startHealth,
              events: fight.events,
              newStages,
              earnedStages: (byAccount.get(me) ?? []).map((r) => r.stage).sort((a, b) => a - b),
            },
            state: await guildBossState(tx, me, now),
          };
        },
      );
    },
  );

  // Pay every earned, unclaimed stage reward of the account to one of its heroes.
  app.post(
    '/guild/boss/claim',
    { preHandler: app.requireAccount, schema: { body: heroBody } },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const { characterId } = request.body as { characterId: string };
      return idempotentTransaction<GuildBossClaimResponse>(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx) => {
          const now = activity.now();
          await lockGuildBossAccount(tx, me);
          const hero = await lockOwnedCharacter(tx, me, characterId, activity);
          const rows = await tx
            .select()
            .from(guildBossRewards)
            .where(
              and(
                eq(guildBossRewards.accountId, me),
                eq(guildBossRewards.status, 'earned'),
                isNull(guildBossRewards.claimedAt),
              ),
            )
            .orderBy(asc(guildBossRewards.week), asc(guildBossRewards.stage))
            .for('update');
          const standing = (await membershipOf(tx, me))?.member.role ?? 'none';
          decide(standing, 'claim', undefined, { unclaimed: rows.length });
          const gold = rows.reduce((s, r) => s + r.gold, 0);
          const materials = sumBundles(rows);
          // Exactly the rows read above (a stage another member breaks meanwhile waits for the next
          // claim).
          for (const r of rows) {
            await tx
              .update(guildBossRewards)
              .set({ claimedAt: now, characterId: hero.id })
              .where(
                and(
                  eq(guildBossRewards.accountId, me),
                  eq(guildBossRewards.week, r.week),
                  eq(guildBossRewards.stage, r.stage),
                ),
              );
          }
          const character = await changeGold(tx, hero, gold, now);
          await changeMaterialsTx(tx, hero.id, materials, now);
          const rewards = rows.map((r) => ({ week: r.week, stage: r.stage }));
          await writeAudit(tx, {
            event: 'guild_boss.claim',
            accountId: me,
            characterId: hero.id,
            data: {
              gold,
              goldAfter: character.gold,
              materials,
              rewards: rows.map((r) => ({
                week: r.week,
                stage: r.stage,
                guildId: r.guildId,
                bossId: r.bossId,
              })),
            },
          });
          recordTelemetry(tx, now, [
            ...goldIn('guild_boss', '', gold),
            ...materialCounts('material.in', 'guild_boss', materials),
          ]);
          return { claimed: { gold, materials, rewards }, character: characterView(character) };
        },
      );
    },
  );
}

/** Test support: every attempt row of a guild's week, oldest first. */
export async function attemptsOfGuildWeek(executor: Executor, guildId: string, week: string) {
  return executor
    .select()
    .from(guildBossAttempts)
    .where(and(eq(guildBossAttempts.guildId, guildId), eq(guildBossAttempts.week, week)))
    .orderBy(asc(guildBossAttempts.createdAt), asc(guildBossAttempts.id));
}
