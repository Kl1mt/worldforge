/**
 * The weekly guild boss (ticket 4.9, docs/GUILD_BOSS.md): attempts, the permission matrix (every
 * standing × view / attempt / claim, plus blocks, mutes and kicks), stage rewards and their
 * fairness rules (leavers keep theirs, late joiners get none of the past, switching guilds never
 * doubles attempts or stages), the week boundary, invariance, and reconciliation with the audit log.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  getGuildBoss,
  guildBossWeek,
  simulateGuildBossAttempt,
  bossModifierOfWeek,
  guildBossWeekFromKey,
  sumStageRewards,
  type ClassId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accountAchievements,
  auditLog,
  blocks,
  characterMaterials,
  characters,
  guildBossAttempts,
  guildBossRewards,
  guildBossStages,
  guildBossStreams,
  guildBossWeeks,
  guildMembers,
  sanctions,
  type Guild,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import type {
  GuildBossAttemptResponse,
  GuildBossClaimResponse,
  GuildBossStateResponse,
} from './routes.js';
import { attemptSeed } from './model.js';
import { setTestAccount } from '../admin/test-accounts.js';

const boss = getGuildBoss('risenGravewarden');
const DAY = 86_400_000;
const SATURDAY = Date.parse('2026-11-07T12:00:00Z');
const WEEK = guildBossWeek(SATURDAY).key; // 2026-11-02

describe('guild boss', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  let nowMs = SATURDAY;
  const now = () => new Date(nowMs);

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  beforeEach(() => {
    nowMs = SATURDAY;
  });

  const db = () => database.db;
  const account = () => insertAccount(db(), { now: now() });
  const hero = (acc: TestAccount, level = 20, classId: ClassId = 'warrior') =>
    insertCharacter(db(), acc.id, { level, classId });
  const status = (r: { statusCode: number; json: () => unknown }) =>
    r.statusCode < 300
      ? r.statusCode
      : `${r.statusCode} ${(r.json() as { error: { code: string } }).error.code}`;

  const keyed = (who: TestAccount, url: string, payload: object, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'idempotency-key': key },
      cookies: { [SESSION_COOKIE]: who.token },
    });
  const attempt = (who: TestAccount, characterId: string, key: string = randomUUID()) =>
    keyed(who, '/api/guild/boss/attempts', { characterId }, key);
  const claim = (who: TestAccount, characterId: string, key: string = randomUUID()) =>
    keyed(who, '/api/guild/boss/claim', { characterId }, key);
  const state = async (who: TestAccount) => {
    const res = await call(who, 'GET', '/api/guild/boss');
    expect(res.statusCode).toBe(200);
    return res.json<GuildBossStateResponse>();
  };
  const fought = async (who: TestAccount, characterId: string) => {
    const res = await attempt(who, characterId);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<GuildBossAttemptResponse>().attempt;
  };

  /** A guild of fresh accounts, each with a level-20 hero. */
  async function guildOf(roles: ('officer' | 'member')[] = []) {
    const leader = await account();
    const others = await Promise.all(roles.map(() => account()));
    const guild = await insertGuild(db(), leader.id, {
      now: new Date(nowMs - DAY),
      members: others.map((o, i) => ({ accountId: o.id, role: roles[i]! })),
    });
    const heroes = new Map<string, string>();
    for (const a of [leader, ...others]) heroes.set(a.id, (await hero(a)).id);
    return { guild, leader, others, heroOf: (a: TestAccount) => heroes.get(a.id)! };
  }

  /** Moves a guild's weekly counter just below a stage (test shortcut for many attempts). */
  async function nearStage(guild: Guild, stage: number, week = WEEK) {
    const total = boss.stages[stage - 1]!.threshold - 1;
    await db()
      .insert(guildBossWeeks)
      .values({
        guildId: guild.id,
        week,
        bossId: boss.id,
        total,
        attempts: 0,
        stage: stage - 1,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [guildBossWeeks.guildId, guildBossWeeks.week],
        set: { total, stage: stage - 1 },
      });
  }

  const rewardsOf = (accountId: string) =>
    db()
      .select()
      .from(guildBossRewards)
      .where(eq(guildBossRewards.accountId, accountId))
      .orderBy(guildBossRewards.week, guildBossRewards.stage);

  it('an attempt is a server fight from the hero snapshot; a retry replays it', async () => {
    const { leader, heroOf } = await guildOf();
    const key = randomUUID();
    const first = await attempt(leader, heroOf(leader), key);
    expect(first.statusCode).toBe(201);
    const body = first.json<GuildBossAttemptResponse>();
    expect(body.attempt.attemptNo).toBe(1);
    expect(body.attempt.damage).toBeGreaterThan(0);
    expect(body.attempt.counted).toBe(Math.min(body.attempt.damage, boss.attemptDamageCap));
    expect(body.attempt.events.length).toBeGreaterThan(10);
    expect(body.state.me.attemptsLeft).toBe(GUILD_BOSS_ATTEMPTS_PER_WEEK - 1);
    expect(body.state.guild!.total).toBe(body.attempt.counted);
    expect(body.state.guild!.board).toMatchObject([
      { rank: 1, you: true, former: false, damage: body.attempt.counted, attempts: 1 },
    ]);
    // Nothing secret goes out.
    expect(JSON.stringify(body)).not.toMatch(/seed|secret/i);

    const replay = await attempt(leader, heroOf(leader), key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(body);
    expect((await state(leader)).me.attemptsUsed).toBe(1);

    const second = await fought(leader, heroOf(leader));
    expect(second.attemptNo).toBe(2);
    // Each attempt has its own seed. Two seeds can still give the same fight log (this hero's
    // fight has little variance: about 1 secret in 30), so check both fights against game-core
    // with the stored stream instead of asserting that they differ.
    const [stream] = await db()
      .select()
      .from(guildBossStreams)
      .where(eq(guildBossStreams.accountId, leader.id));
    const predicted = (attemptNo: number) =>
      simulateGuildBossAttempt({
        bossId: boss.id,
        character: { classId: 'warrior', level: 20 },
        equipment: [],
        seed: attemptSeed(stream!.seedSecret, guildBossWeek(nowMs), attemptNo),
        // Ticket 6.3: the week's modifier, as the server stores it with the attempt.
        bossModifier: bossModifierOfWeek(nowMs).id,
      });
    expect(body.attempt.events).toEqual(predicted(1).events);
    expect(second.events).toEqual(predicted(2).events);
    await fought(leader, heroOf(leader));
    expect(status(await attempt(leader, heroOf(leader)))).toBe('409 no_attempts_left');
    const s = await state(leader);
    expect(s.me.attempts.map((a) => a.attemptNo)).toEqual([1, 2, 3]);
    expect(s.guild!.attempts).toBe(3);
    expect(s.guild!.total).toBe(s.me.attempts.reduce((t, a) => t + a.counted, 0));
  });

  it('refuses unknown heroes, heroes of another account and heroes below the minimum level', async () => {
    const { leader, others, heroOf } = await guildOf(['member']);
    const weak = await hero(leader, boss.minLevel - 1);
    expect(status(await attempt(leader, weak.id))).toBe('409 hero_too_low');
    expect(status(await attempt(leader, heroOf(others[0]!)))).toBe('404 not_found');
    expect(status(await attempt(leader, randomUUID()))).toBe('404 not_found');
    expect(status(await attempt(leader, 'nope'))).toBe('400 validation_failed');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/guild/boss/attempts',
      payload: { characterId: heroOf(leader) },
      cookies: { [SESSION_COOKIE]: leader.token },
    });
    expect(status(missing)).toBe('400 idempotency_key_required');
    expect((await state(leader)).me.attemptsUsed).toBe(0);
    expect((await call(null, 'GET', '/api/guild/boss')).statusCode).toBe(401);
  });

  describe('permission matrix (standing × action)', () => {
    type Standing = 'leader' | 'officer' | 'member' | 'none';
    const EXPECTED: Record<'view' | 'attempt' | 'claim', Record<Standing, number | string>> = {
      view: { leader: 'guild', officer: 'guild', member: 'guild', none: 'no guild' },
      attempt: { leader: 201, officer: 201, member: 201, none: '404 not_in_guild' },
      // With nothing earned; with a reward it pays (see "rewards").
      claim: {
        leader: '409 nothing_to_claim',
        officer: '409 nothing_to_claim',
        member: '409 nothing_to_claim',
        none: '409 nothing_to_claim',
      },
    };

    it('every standing × action', async () => {
      const { leader, others, heroOf } = await guildOf(['officer', 'member']);
      const stranger = await account();
      const strangerHero = (await hero(stranger)).id;
      const who: Record<Standing, [TestAccount, string]> = {
        leader: [leader, heroOf(leader)],
        officer: [others[0]!, heroOf(others[0]!)],
        member: [others[1]!, heroOf(others[1]!)],
        none: [stranger, strangerHero],
      };
      for (const [standing, [acc, heroId]] of Object.entries(who) as [
        Standing,
        [TestAccount, string],
      ][]) {
        const s = await state(acc);
        expect(s.guild ? 'guild' : 'no guild', `${standing} view`).toBe(EXPECTED.view[standing]);
        expect(status(await claim(acc, heroId)), `${standing} claim`).toBe(
          EXPECTED.claim[standing],
        );
        expect(status(await attempt(acc, heroId)), `${standing} attempt`).toBe(
          EXPECTED.attempt[standing],
        );
      }
      // A stranger's refused attempt spent nothing.
      expect((await state(stranger)).me.attemptsUsed).toBe(0);
    });

    it('a block hides names on the board but blocks no one from fighting', async () => {
      const { leader, others, heroOf } = await guildOf(['member', 'member']);
      const [blocker, blocked] = others as [TestAccount, TestAccount];
      await db().insert(blocks).values({ blockerId: blocker.id, blockedId: blocked.id });
      for (const a of [leader, blocker, blocked]) await fought(a, heroOf(a));
      const rowsFor = async (viewer: TestAccount) =>
        (await state(viewer)).guild!.board.map((r) => ({
          name: r.player?.displayName ?? null,
          blocked: r.blocked,
          you: r.you,
        }));
      const seenByBlocker = await rowsFor(blocker);
      expect(seenByBlocker).toContainEqual({ name: null, blocked: true, you: false });
      expect(seenByBlocker).toContainEqual({
        name: leader.displayName,
        blocked: false,
        you: false,
      });
      // Either way: the blocked player does not see the blocker's name either.
      expect(await rowsFor(blocked)).toContainEqual({ name: null, blocked: true, you: false });
      expect((await rowsFor(leader)).every((r) => r.name !== null)).toBe(true);
    });

    it('a mute does not stop a fight (no text, no one reached); a kick does at once', async () => {
      const { leader, others, heroOf } = await guildOf(['member', 'member']);
      const [muted, kicked] = others as [TestAccount, TestAccount];
      await db()
        .insert(sanctions)
        .values({
          id: uuidv7(),
          subjectId: muted.id,
          kind: 'mute',
          reason: 'Spam',
          createdAt: now(),
          expiresAt: new Date(nowMs + DAY),
        });
      expect(status(await attempt(muted, heroOf(muted)))).toBe(201);
      const hit = await fought(kicked, heroOf(kicked));
      expect(status(await call(leader, 'POST', `/api/guild/members/${kicked.handle}/kick`))).toBe(
        200,
      );
      expect(status(await attempt(kicked, heroOf(kicked)))).toBe('404 not_in_guild');
      const s = await state(kicked);
      expect(s.guild).toBeNull();
      expect(s.me.attemptsUsed).toBe(1);
      // Their damage stays with the guild they fought for, without their name.
      const board = (await state(leader)).guild!.board;
      expect(board).toContainEqual(
        expect.objectContaining({ player: null, former: true, damage: hit.counted }),
      );
    });
  });

  describe('rewards', () => {
    it('a threshold lowered mid-week is reached at the next attempt (ticket B.3)', async () => {
      const { guild, leader, heroOf } = await guildOf();
      // Before B.3 stage 2 stood at 120,000: a week at 110,000 had recorded stage 1 only.
      await db().insert(guildBossWeeks).values({
        guildId: guild.id,
        week: WEEK,
        bossId: boss.id,
        total: 110_000,
        attempts: 0,
        stage: 1,
        updatedAt: now(),
      });
      expect(boss.stages[1]!.threshold).toBeLessThanOrEqual(110_000);
      const next = await fought(leader, heroOf(leader));
      expect(next.newStages).toEqual([2]);
      const [week] = await db()
        .select()
        .from(guildBossWeeks)
        .where(eq(guildBossWeeks.guildId, guild.id));
      expect(week!.stage).toBe(2);
      expect(
        (
          await db().select().from(guildBossStages).where(eq(guildBossStages.guildId, guild.id))
        ).map((r) => r.stage),
      ).toEqual([2]);
    });

    it('a stage pays everyone who fought; members who have not fought earn it with their first attempt', async () => {
      const { guild, leader, others, heroOf } = await guildOf(['member', 'member']);
      const [early, later] = others as [TestAccount, TestAccount];
      await fought(early, heroOf(early));
      await nearStage(guild, 1);
      const breaking = await fought(leader, heroOf(leader));
      expect(breaking.newStages).toEqual([1]);
      expect(breaking.earnedStages).toEqual([1]);
      expect((await rewardsOf(early.id)).map((r) => [r.stage, r.status])).toEqual([[1, 'earned']]);
      expect((await rewardsOf(later.id)).map((r) => [r.stage, r.status])).toEqual([[1, 'pending']]);
      expect((await state(later)).me.pendingStages).toEqual([1]);
      // Achievements come with the earned reward, not with a pending one.
      const ach = async (a: TestAccount) =>
        (
          await db()
            .select()
            .from(accountAchievements)
            .where(eq(accountAchievements.accountId, a.id))
        ).map((r) => r.achievementId);
      expect(await ach(early)).toContain('guildBossFirstStage');
      expect(await ach(later)).not.toContain('guildBossFirstStage');

      const first = await fought(later, heroOf(later));
      expect(first.earnedStages).toEqual([1]);
      expect(first.newStages).toEqual([]);
      expect(await ach(later)).toContain('guildBossFirstStage');
      expect((await state(later)).me.rewards).toMatchObject([
        {
          week: WEEK,
          stage: 1,
          stageName: boss.stages[0]!.name,
          gold: boss.stages[0]!.reward.gold,
        },
      ]);

      // Claim pays the hero once; a retry replays; a new key has nothing left.
      const goldBefore = (
        await db()
          .select()
          .from(characters)
          .where(eq(characters.id, heroOf(later)))
      )[0]!.gold;
      const key = randomUUID();
      const paid = await claim(later, heroOf(later), key);
      expect(paid.statusCode).toBe(200);
      const body = paid.json<GuildBossClaimResponse>();
      const expected = sumStageRewards(boss, [1]);
      expect(body.claimed).toEqual({ ...expected, rewards: [{ week: WEEK, stage: 1 }] });
      expect(body.character.gold).toBe(goldBefore + expected.gold);
      expect((await claim(later, heroOf(later), key)).json()).toEqual(body);
      expect(status(await claim(later, heroOf(later)))).toBe('409 nothing_to_claim');
      const mats = await db()
        .select()
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, heroOf(later)));
      for (const [m, n] of Object.entries(expected.materials))
        expect(mats.find((x) => x.materialId === m)?.quantity).toBe(n);
    });

    it('a leaver keeps their earned reward; their damage stays with the guild', async () => {
      const { guild, leader, others, heroOf } = await guildOf(['member']);
      const leaver = others[0]!;
      const hit = await fought(leaver, heroOf(leaver));
      await nearStage(guild, 1);
      await fought(leader, heroOf(leader));
      const totalBefore = (await state(leader)).guild!.total;
      expect(status(await call(leaver, 'POST', '/api/guild/leave'))).toBe(200);
      const s = await state(leaver);
      expect(s.guild).toBeNull();
      expect(s.me.rewards.map((r) => r.stage)).toEqual([1]);
      expect(s.me.rewards[0]).toMatchObject({ guildName: guild.name, guildTag: guild.tag });
      expect(status(await claim(leaver, heroOf(leaver)))).toBe(200);
      const board = (await state(leader)).guild!.board;
      expect(board.find((r) => r.former)).toMatchObject({ player: null, damage: hit.counted });
      // The guild's total is unchanged by the leave.
      expect((await state(leader)).guild!.total).toBe(totalBefore);
    });

    it('a late joiner cannot claim a stage reached before they joined', async () => {
      const { guild, leader, heroOf } = await guildOf();
      await nearStage(guild, 1);
      await fought(leader, heroOf(leader));
      const late = await account();
      const lateHero = (await hero(late)).id;
      await db()
        .insert(guildMembers)
        .values({ accountId: late.id, guildId: guild.id, role: 'member', joinedAt: now() });
      const a = await fought(late, lateHero);
      expect(a.earnedStages).toEqual([]);
      expect(await rewardsOf(late.id)).toEqual([]);
      expect((await state(late)).me.rewards).toEqual([]);
      // The next stage is theirs.
      await nearStage(guild, 2);
      await fought(leader, heroOf(leader));
      expect((await rewardsOf(late.id)).map((r) => [r.stage, r.status])).toEqual([[2, 'earned']]);
    });

    it('a member who leaves before fighting loses the pending stage; a new guild gives nothing already taken', async () => {
      const a = await guildOf(['member']);
      const b = await guildOf();
      const mover = a.others[0]!;
      const moverHero = a.heroOf(mover);
      await nearStage(a.guild, 1);
      await fought(a.leader, a.heroOf(a.leader));
      expect((await rewardsOf(mover.id)).map((r) => r.status)).toEqual(['pending']);
      expect(status(await call(mover, 'POST', '/api/guild/leave'))).toBe(200);
      // B is past stage 1 already: joining late earns nothing of it, and A's pending row stays A's.
      await nearStage(b.guild, 1);
      await fought(b.leader, b.heroOf(b.leader));
      await db()
        .insert(guildMembers)
        .values({ accountId: mover.id, guildId: b.guild.id, role: 'member', joinedAt: now() });
      const first = await fought(mover, moverHero);
      expect(first.earnedStages).toEqual([]);
      expect((await rewardsOf(mover.id)).map((r) => [r.stage, r.status, r.guildId])).toEqual([
        [1, 'pending', a.guild.id],
      ]);
    });

    it('switching guilds mid-week neither refreshes attempts nor pays a stage twice', async () => {
      const a = await guildOf(['member']);
      const b = await guildOf();
      const mover = a.others[0]!;
      const moverHero = a.heroOf(mover);
      await fought(mover, moverHero);
      await nearStage(a.guild, 1);
      await fought(mover, moverHero); // breaks A's stage 1: earned
      expect(status(await call(mover, 'POST', '/api/guild/leave'))).toBe(200);
      await db()
        .insert(guildMembers)
        .values({ accountId: mover.id, guildId: b.guild.id, role: 'member', joinedAt: now() });
      const s = await state(mover);
      expect(s.me.attemptsUsed).toBe(2);
      expect(s.me.attemptsLeft).toBe(1);
      expect(s.me.attempts.map((x) => x.forThisGuild)).toEqual([false, false]);
      await fought(mover, moverHero);
      expect(status(await attempt(mover, moverHero))).toBe('409 no_attempts_left');
      // B reaches stage 1 with the mover's help: still one stage-1 reward for the week (A's).
      await nearStage(b.guild, 1);
      await fought(b.leader, b.heroOf(b.leader));
      const rows = await rewardsOf(mover.id);
      expect(rows.map((r) => [r.stage, r.status, r.guildId])).toEqual([[1, 'earned', a.guild.id]]);
      // Their damage is split by the guild each attempt was fought for.
      const counted = await db()
        .select({ guildId: guildBossAttempts.guildId, n: sql<number>`count(*)::int` })
        .from(guildBossAttempts)
        .where(eq(guildBossAttempts.accountId, mover.id))
        .groupBy(guildBossAttempts.guildId);
      expect(Object.fromEntries(counted.map((c) => [c.guildId, c.n]))).toEqual({
        [a.guild.id]: 2,
        [b.guild.id]: 1,
      });
    });
  });

  describe('the week (Monday 00:00 UTC)', () => {
    it('counts an attempt in the week of its moment; attempts and totals start over on Monday', async () => {
      const { guild, leader, heroOf } = await guildOf();
      const monday = Date.parse('2026-11-09T00:00:00Z');
      nowMs = monday - 1; // Sunday 23:59:59.999
      await fought(leader, heroOf(leader));
      await fought(leader, heroOf(leader));
      await fought(leader, heroOf(leader));
      expect(status(await attempt(leader, heroOf(leader)))).toBe('409 no_attempts_left');
      await nearStage(guild, 1);
      nowMs = monday - 1;
      // Stage 1 of the old week, then the clock turns.
      const crossing = await (async () => {
        const [w] = await db()
          .select()
          .from(guildBossWeeks)
          .where(and(eq(guildBossWeeks.guildId, guild.id), eq(guildBossWeeks.week, WEEK)));
        return w!;
      })();
      expect(crossing.stage).toBe(0);
      nowMs = monday;
      const s = await state(leader);
      expect(s.week).toEqual({
        key: '2026-11-09',
        startsAt: '2026-11-09T00:00:00.000Z',
        endsAt: '2026-11-16T00:00:00.000Z',
      });
      expect(s.me.attemptsLeft).toBe(GUILD_BOSS_ATTEMPTS_PER_WEEK);
      expect(s.guild!.total).toBe(0);
      const fresh = await fought(leader, heroOf(leader));
      expect(fresh).toMatchObject({ week: '2026-11-09', attemptNo: 1 });
      const weeks = await db()
        .select({ week: guildBossAttempts.week, n: sql<number>`count(*)::int` })
        .from(guildBossAttempts)
        .where(eq(guildBossAttempts.guildId, guild.id))
        .groupBy(guildBossAttempts.week);
      expect(Object.fromEntries(weeks.map((w) => [w.week, w.n]))).toEqual({
        [WEEK]: 3,
        '2026-11-09': 1,
      });
      // The old week's counter did not move after Sunday.
      const [old] = await db()
        .select()
        .from(guildBossWeeks)
        .where(and(eq(guildBossWeeks.guildId, guild.id), eq(guildBossWeeks.week, WEEK)));
      expect(old!.total).toBe(crossing.total);
    });

    it('attempts across a modifier change fight the modifier of their own week (ticket 6.3)', async () => {
      const { leader, heroOf } = await guildOf();
      const monday = Date.parse('2026-11-09T00:00:00Z');
      const old = bossModifierOfWeek(monday - 1).id;
      const fresh = bossModifierOfWeek(monday).id;
      expect(fresh).not.toBe(old);
      nowMs = monday - 1; // Sunday 23:59:59.999
      expect((await state(leader)).bossModifier.id).toBe(old);
      const before = await fought(leader, heroOf(leader));
      expect(before.bossModifier!.id).toBe(old);
      nowMs = monday;
      expect((await state(leader)).bossModifier.id).toBe(fresh);
      const after = await fought(leader, heroOf(leader));
      expect(after.bossModifier!.id).toBe(fresh);
      // Stored per attempt, and each replays exactly from its stream, snapshot and modifier.
      const rows = await db()
        .select()
        .from(guildBossAttempts)
        .where(eq(guildBossAttempts.accountId, leader.id))
        .orderBy(guildBossAttempts.createdAt);
      expect(rows.map((r) => [r.week, r.attemptNo, r.bossModifier])).toEqual([
        [WEEK, 1, old],
        ['2026-11-09', 1, fresh],
      ]);
      const [stream] = await db()
        .select()
        .from(guildBossStreams)
        .where(eq(guildBossStreams.accountId, leader.id));
      for (const [r, view] of [
        [rows[0]!, before],
        [rows[1]!, after],
      ] as const) {
        const replay = simulateGuildBossAttempt({
          bossId: r.bossId,
          character: { classId: r.snapshot.classId, level: r.snapshot.level },
          equipment: r.snapshot.equipment,
          seed: attemptSeed(stream!.seedSecret, guildBossWeekFromKey(r.week), r.attemptNo),
          bossModifier: r.bossModifier,
        });
        expect(view.events).toEqual(replay.events);
        expect([r.damage, r.counted, r.end]).toEqual([replay.damage, replay.counted, replay.end]);
      }
      // A row from before 6.3 (no modifier) replays as the fight it was.
      const plain = simulateGuildBossAttempt({
        bossId: rows[0]!.bossId,
        character: { classId: rows[0]!.snapshot.classId, level: rows[0]!.snapshot.level },
        equipment: rows[0]!.snapshot.equipment,
        seed: attemptSeed(stream!.seedSecret, guildBossWeekFromKey(WEEK), 1),
        bossModifier: null,
      });
      expect('bossModifier' in plain).toBe(false);
    });

    it("last week's earned rewards stay claimable", async () => {
      const { guild, leader, heroOf } = await guildOf();
      await nearStage(guild, 1);
      await fought(leader, heroOf(leader));
      nowMs = SATURDAY + 9 * DAY;
      const s = await state(leader);
      expect(s.week.key).not.toBe(WEEK);
      expect(s.me.rewards.map((r) => [r.week, r.stage])).toEqual([[WEEK, 1]]);
      expect(status(await claim(leader, heroOf(leader)))).toBe(200);
    });
  });

  it('invariance: an attempt is decided by the stream and the snapshot, not by when it is made', async () => {
    // Two accounts given the same secret and the same hero fight the same fights, however their
    // requests are timed (all at once vs. spread over the week, with reads in between).
    const one = await guildOf();
    const two = await guildOf();
    const secret = 'a'.repeat(32);
    await db()
      .insert(guildBossStreams)
      .values([
        { accountId: one.leader.id, seedSecret: secret },
        { accountId: two.leader.id, seedSecret: secret },
      ]);
    const a: number[] = [];
    const b: number[] = [];
    nowMs = Date.parse('2026-11-02T00:00:01Z');
    for (let i = 0; i < 3; i++) a.push((await fought(one.leader, one.heroOf(one.leader))).damage);
    for (const t of ['2026-11-03T08:00:00Z', '2026-11-05T19:30:00Z', '2026-11-08T23:59:59Z']) {
      nowMs = Date.parse(t);
      await state(two.leader);
      b.push((await fought(two.leader, two.heroOf(two.leader))).damage);
    }
    expect(b).toEqual(a);
    // And they are exactly the game-core simulation of that stream.
    const expected = [1, 2, 3].map(
      (n) =>
        simulateGuildBossAttempt({
          bossId: boss.id,
          character: { classId: 'warrior', level: 20 },
          equipment: [],
          seed: `${secret}:2026-11-02:${n}`,
          bossModifier: bossModifierOfWeek(guildBossWeekFromKey('2026-11-02')).id,
        }).damage,
    );
    expect(a).toEqual(expected);
  });

  // Ticket 6.10 (docs/PHASE6_EXPLOIT_REVIEW.md F1): a test account's hero can be levelled and
  // geared by the admin cheat tools, and the stages its blows break pay every member of the guild.
  // So it fights only for a guild of test accounts: minted power never pays real players.
  it('a test account fights only for a guild of test accounts (no stage pays real players)', async () => {
    const { guild, leader, others, heroOf } = await guildOf(['member']);
    const tester = others[0]!;
    await setTestAccount(db(), tester.handle, true);
    await nearStage(guild, 1);
    const before = await db()
      .select()
      .from(guildBossWeeks)
      .where(and(eq(guildBossWeeks.guildId, guild.id), eq(guildBossWeeks.week, WEEK)));

    const refused = await attempt(tester, heroOf(tester));
    expect(status(refused)).toBe('403 test_account');
    // Nothing moved: no attempt, no total, no stage, no reward for the real leader.
    expect(
      await db().select().from(guildBossAttempts).where(eq(guildBossAttempts.accountId, tester.id)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(guildBossWeeks)
        .where(and(eq(guildBossWeeks.guildId, guild.id), eq(guildBossWeeks.week, WEEK))),
    ).toEqual(before);
    expect(
      await db().select().from(guildBossRewards).where(eq(guildBossRewards.accountId, leader.id)),
    ).toEqual([]);
    // The real player still fights; the test account's view still loads.
    expect((await state(tester)).guild).not.toBeNull();
    await fought(leader, heroOf(leader));

    // A guild of test accounts only: test away.
    const t = await guildOf(['member']);
    await setTestAccount(db(), t.leader.handle, true);
    await setTestAccount(db(), t.others[0]!.handle, true);
    await fought(t.others[0]!, t.heroOf(t.others[0]!));

    // Ticket 8.7 (F4): the stages a guild of test accounts broke stay with it, so a real player
    // may not join it (by invite or application): its minted stages would pay them and rank it.
    const real = await account();
    const invited = await call(t.leader, 'POST', '/api/guild/invites', { handle: real.handle });
    expect(invited.statusCode, invited.body).toBe(200);
    const joined = await call(real, 'POST', `/api/guilds/${t.guild.handle}/invite/accept`);
    expect(status(joined)).toBe('403 test_guild');
    const applied = await call(real, 'POST', `/api/guilds/${t.guild.handle}/apply`);
    if (applied.statusCode === 200) {
      const taken = await call(t.leader, 'POST', `/api/guild/applications/${real.handle}/accept`);
      expect(status(taken)).toBe('403 test_guild');
    } else {
      expect(status(applied)).toBe('403 test_guild');
    }
    expect(
      await db().select().from(guildMembers).where(eq(guildMembers.accountId, real.id)),
    ).toEqual([]);
    // A test account may still join a real guild (it just can't fight there, F1).
    const realGuild = await guildOf();
    const probe = await account();
    await setTestAccount(db(), probe.handle, true);
    await call(realGuild.leader, 'POST', '/api/guild/invites', { handle: probe.handle });
    const ok = await call(probe, 'POST', `/api/guilds/${realGuild.guild.handle}/invite/accept`);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('reconciles: totals equal the attempts, telemetry equals the audit log', async () => {
    const totals = await db()
      .select({
        guildId: guildBossAttempts.guildId,
        week: guildBossAttempts.week,
        sum: sql<number>`sum(${guildBossAttempts.counted})::int`,
        n: sql<number>`count(*)::int`,
      })
      .from(guildBossAttempts)
      .groupBy(guildBossAttempts.guildId, guildBossAttempts.week);
    const weeks = await db().select().from(guildBossWeeks);
    for (const t of totals) {
      const w = weeks.find((x) => x.guildId === t.guildId && x.week === t.week)!;
      // Counters moved by `nearStage` carry the seeded offset; the attempt count is always exact.
      expect(w.attempts).toBe(t.n);
    }
    const checks = await reconcileWithAudit(db());
    const boss = checks.filter((c) => c.check.startsWith('guild boss:'));
    expect(boss.length).toBe(5);
    for (const c of boss) expect(c, c.check).toMatchObject({ ok: true });
    expect(boss.find((c) => c.check === 'guild boss: attempts')!.audit).toBe(
      totals.reduce((s, t) => s + t.n, 0),
    );
    const earnGold = await db()
      .select({ n: sql<number>`coalesce(sum((data->>'gold')::int), 0)::int` })
      .from(auditLog)
      .where(eq(auditLog.event, 'guild_boss.earn'));
    const rowGold = await db()
      .select({ n: sql<number>`coalesce(sum(gold), 0)::int` })
      .from(guildBossRewards)
      .where(eq(guildBossRewards.status, 'earned'));
    expect(earnGold[0]!.n).toBe(rowGold[0]!.n);
  });
});
