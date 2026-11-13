/**
 * Ticket 9.4 (docs/ACCOUNTS.md): earned character slots and the offline cap. The settlement at
 * each step's edges (just under, at, just over), deeds earned during the window, after it and
 * during a settlement, slots checked in hero creation, grants at most once and audited, the
 * community seam never granted, test accounts on the same rules, and the backfill run twice (and
 * resumed after a crash). Dates derive from the wall clock (CLAUDE.md "Dates"); the clock is
 * injected, never waited on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { OFFLINE_RULES, xpToNextLevel } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  DEFAULT_ACTIVITY_OPTIONS,
  settleActivityTx,
  type ActivityOptions,
} from '../activity/settle.js';
import {
  accountGrowthGrants,
  accounts,
  activities,
  auditLog,
  characters,
  dataBackfills,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import { queryRows } from '../db/query.js';
import type { Database, DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { refreshAchievements } from '../achievements/award.js';
import { ACCOUNT_GROWTH_BACKFILL_ID, backfillAccountGrowthAll } from './backfill.js';
import type { AccountGrowthResponse } from './routes.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const CAP = 3 * HOUR;
const STEPS = [3, 4, 5, 6, 8].map((h) => h * HOUR);
const T0 = Math.floor((Date.now() + 86_400_000) / HOUR) * HOUR;

let nowMs = T0;
const options: ActivityOptions = {
  ...DEFAULT_ACTIVITY_OPTIONS,
  offlineCapMs: CAP,
  now: () => new Date(nowMs),
};

let database: DatabaseHandle;
let app: ReturnType<typeof buildApp>;
let call: ReturnType<typeof caller>;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: {
      now: () => new Date(nowMs),
      accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
    },
    activity: options,
  });
  await app.ready();
  call = caller(app);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

/** A player with one active hero farming the first area since `nowMs`. */
async function farmer(hero: { level?: number } = {}) {
  const who = await insertAccount(db(), { now: new Date(nowMs) });
  const c = await insertCharacter(db(), who.id, hero);
  expect((await call(who, 'POST', `/api/characters/${c.id}/select`)).statusCode).toBe(200);
  const started = await call(who, 'POST', `/api/characters/${c.id}/activity`, {
    areaId: 'abandonedFields',
  });
  expect(started.statusCode).toBe(201);
  return { who, hero: c };
}

/** A scheduled (untouched) settlement at the current clock. */
function settleAway(characterId: string) {
  return withTransaction(db(), (tx) =>
    settleActivityTx(tx, characterId, options, { touch: false }),
  );
}

async function grantOffline(accountId: string, n: number, at: number) {
  for (const rule of OFFLINE_RULES.slice(0, n)) {
    await db()
      .insert(accountGrowthGrants)
      .values({
        accountId,
        grantId: rule.id,
        kind: 'offline',
        source: rule.id,
        grantedAt: new Date(at),
      });
  }
}

async function grantsOf(executor: Database, accountId: string) {
  const rows = await executor
    .select()
    .from(accountGrowthGrants)
    .where(eq(accountGrowthGrants.accountId, accountId));
  return rows.map((r) => r.grantId).sort();
}

async function growAudits(accountId: string) {
  const rows = await db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'account.grow')));
  return rows.map((r) => String(r.data.grantId)).sort();
}

describe('the offline cap at each step’s edges', () => {
  for (const [deeds, cap] of STEPS.entries()) {
    it(`${deeds} deed(s): ${cap / HOUR} h, nothing capped just under or at it, 1 s just over`, async () => {
      nowMs = T0;
      const { who, hero } = await farmer();
      // Earned before the last contact: in force for the whole window.
      await grantOffline(who.id, deeds, T0 - HOUR);

      nowMs = T0 + cap - SEC;
      const under = await settleAway(hero.id);
      expect(under).toMatchObject({ creditedMs: cap - SEC, cappedMs: 0 });
      nowMs = T0 + cap;
      const at = await settleAway(hero.id);
      expect(at).toMatchObject({ creditedMs: SEC, cappedMs: 0 });
      nowMs = T0 + cap + SEC;
      const over = await settleAway(hero.id);
      expect(over).toMatchObject({ creditedMs: 0, cappedMs: SEC });

      // The activity view reports the account's cap, not the base.
      const view = await call(who, 'GET', `/api/characters/${hero.id}/activity`);
      expect(view.json().offlineCapMs).toBe(cap);
    });
  }
});

describe('a deed counts from the moment it is earned', () => {
  it('earned while the cap still runs: the window grows to the next step', async () => {
    nowMs = T0;
    const { who, hero } = await farmer();
    await grantOffline(who.id, 1, T0 + 2 * HOUR);
    nowMs = T0 + 6 * HOUR;
    expect(await settleAway(hero.id)).toMatchObject({ creditedMs: 4 * HOUR, cappedMs: 2 * HOUR });
  });

  it('earned exactly as the cap runs out: still counts', async () => {
    nowMs = T0;
    const { who, hero } = await farmer();
    await grantOffline(who.id, 1, T0 + CAP);
    nowMs = T0 + 6 * HOUR;
    expect(await settleAway(hero.id)).toMatchObject({ creditedMs: 4 * HOUR, cappedMs: 2 * HOUR });
  });

  it('earned after the cap ran out: time already lost is never paid back', async () => {
    nowMs = T0;
    const { who, hero } = await farmer();
    await grantOffline(who.id, 1, T0 + CAP + SEC);
    nowMs = T0 + 6 * HOUR;
    expect(await settleAway(hero.id)).toMatchObject({ creditedMs: CAP, cappedMs: 3 * HOUR });
  });

  it('earned during a settlement: in force from that settlement on, not before it', async () => {
    nowMs = T0;
    // One XP short of level 10 (the first offline deed). A level-9 hero in the first area kills
    // hundreds of times in 30 minutes on every seed (measured with game-core over 1000 seeds).
    const { who, hero } = await farmer({ level: 9 });
    await db()
      .update(characters)
      .set({ experience: xpToNextLevel(9) - 1 })
      .where(eq(characters.id, hero.id));

    nowMs = T0 + 30 * MIN;
    const first = await settleAway(hero.id);
    expect(first?.character.level).toBeGreaterThanOrEqual(10);
    const [grant] = await db()
      .select()
      .from(accountGrowthGrants)
      .where(
        and(
          eq(accountGrowthGrants.accountId, who.id),
          eq(accountGrowthGrants.grantId, 'offlineLevel10'),
        ),
      );
    expect(grant).toMatchObject({
      kind: 'offline',
      source: 'offlineLevel10',
      characterId: hero.id,
      backfill: false,
    });
    expect(grant!.grantedAt.getTime()).toBe(T0 + 30 * MIN);
    expect(await growAudits(who.id)).toEqual(['offlineLevel10']);

    // Away until well past both caps: credit ends at the 4 h step, counted from the contact.
    nowMs = T0 + 6 * HOUR;
    const second = await settleAway(hero.id);
    expect(second).toMatchObject({ creditedMs: 4 * HOUR - 30 * MIN, cappedMs: 2 * HOUR });
  });

  it('a hero who keeps contact is never capped, with or without deeds', async () => {
    nowMs = T0;
    const { who, hero } = await farmer();
    for (let i = 0; i < 10; i++) {
      nowMs += HOUR;
      const res = await call(who, 'POST', `/api/characters/${hero.id}/activity/settle`);
      expect(res.statusCode).toBe(200);
    }
    const [row] = await db().select().from(activities).where(eq(activities.characterId, hero.id));
    expect(row!.summary.cappedMs).toBe(0);
  });
});

describe('character slots', () => {
  const create = (who: TestAccount, name: string) =>
    call(who, 'POST', '/api/characters', { name, classId: 'mage', appearance: { banner: 'ash' } });

  it('the server checks earned slots in hero creation; a grant is made once and audited', async () => {
    nowMs = T0;
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    const veteran = await insertCharacter(db(), who.id, { level: 27 });
    await insertCharacter(db(), who.id);
    const refused = await create(who, 'Wenna');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      code: 'no_free_slot',
      details: { slots: { used: 2, total: 2 } },
    });
    const list = (await call(who, 'GET', '/api/characters')).json();
    expect(list.slots).toMatchObject({
      used: 2,
      total: 2,
      locked: { source: 'level28', available: true },
    });

    // The hero reaches level 28: the same hook as a settlement's level-up, run three times.
    const [at28] = await db()
      .update(characters)
      .set({ level: 28 })
      .where(eq(characters.id, veteran.id))
      .returning();
    for (let i = 0; i < 3; i++) {
      await withTransaction(db(), (tx) =>
        refreshAchievements(tx, at28!, ['maxCharacterLevel'], new Date(nowMs)),
      );
    }
    expect(await grantsOf(db(), who.id)).toEqual(['level28', 'offlineLevel10']);
    expect(await growAudits(who.id)).toEqual(['level28', 'offlineLevel10']);

    expect((await create(who, 'Wenna')).statusCode).toBe(201);
    const third = (await call(who, 'GET', '/api/characters')).json();
    expect(third.slots).toMatchObject({
      used: 3,
      total: 3,
      locked: { source: 'heroicCrypt', available: true },
    });
    expect((await create(who, 'Wennb')).statusCode).toBe(422);
  });

  it('the Heroic crypt gives the 4th slot; the community slot is a seam no hero can earn', async () => {
    nowMs = T0;
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    const hero = await insertCharacter(db(), who.id, {
      level: 60,
      progress: {
        gravewardenDefeated: true,
        cryptTierCleared: 4,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
        hollowSovereignDefeated: true,
      },
    });
    await withTransaction(db(), (tx) =>
      refreshAchievements(tx, hero, ['maxCharacterLevel', 'cryptTierCleared'], new Date(nowMs)),
    );
    expect(await grantsOf(db(), who.id)).toEqual([
      'heroicCrypt',
      'level28',
      'offlineCinderwastes',
      'offlineCrypt1',
      'offlineCrypt3',
      'offlineLevel10',
    ]);
    const growth = (await call(who, 'GET', '/api/account/growth')).json<AccountGrowthResponse>();
    expect(growth.slots).toMatchObject({ base: 2, total: 4, used: 1 });
    expect(growth.slots.entries.map((e) => [e.source, e.available, e.grantedAt !== null])).toEqual([
      ['level28', true, true],
      ['heroicCrypt', true, true],
      ['community', false, false],
    ]);
    expect(growth.offline).toMatchObject({ baseMs: CAP, capMs: 8 * HOUR, nextCapMs: null });
    expect(growth.offline.stepsMs).toEqual(STEPS);
    const list = (await call(who, 'GET', '/api/characters')).json();
    expect(list.slots.locked).toMatchObject({ source: 'community', available: false });
  });

  it('a new account: two slots, 3 h, and what comes next', async () => {
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    const growth = (await call(who, 'GET', '/api/account/growth')).json<AccountGrowthResponse>();
    expect(growth.slots).toMatchObject({ base: 2, total: 2, used: 0 });
    expect(growth.slots.entries.every((e) => e.grantedAt === null)).toBe(true);
    expect(growth.offline).toMatchObject({ capMs: CAP, nextCapMs: 4 * HOUR });
    expect(growth.offline.deeds).toHaveLength(4);
    expect((await call(null, 'GET', '/api/account/growth')).statusCode).toBe(401);
  });

  it('test accounts follow the same rules (D.4)', async () => {
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    await db().update(accounts).set({ isTest: true }).where(eq(accounts.id, who.id));
    const hero = await insertCharacter(db(), who.id, { level: 28 });
    await withTransaction(db(), (tx) =>
      refreshAchievements(tx, hero, ['maxCharacterLevel'], new Date(nowMs)),
    );
    expect(await grantsOf(db(), who.id)).toEqual(['level28', 'offlineLevel10']);
  });
});

describe('the backfill', () => {
  it('grants what existing accounts earned, can run twice, and resumes after a crash', async () => {
    const own = await createTestDatabase();
    try {
      const odb = own.db;
      const at = new Date(T0);
      const vet = await insertAccount(odb, { now: at });
      await insertCharacter(odb, vet.id, { level: 30, progress: { gravewardenDefeated: true } });
      // A second hero earning the same deed: still one grant.
      await insertCharacter(odb, vet.id, { level: 12 });
      const others = await Promise.all([1, 2, 3].map(() => insertAccount(odb, { now: at })));
      for (const o of others) await insertCharacter(odb, o.id, { level: 10 });
      const newbie = await insertAccount(odb, { now: at });
      await insertCharacter(odb, newbie.id, { level: 3 });

      await expect(
        backfillAccountGrowthAll(odb, { now: () => at, failAfterAccounts: 2 }),
      ).rejects.toThrow(/stopped/);
      const [none] = await odb
        .select()
        .from(dataBackfills)
        .where(eq(dataBackfills.id, ACCOUNT_GROWTH_BACKFILL_ID));
      expect(none).toBeUndefined();

      const first = await backfillAccountGrowthAll(odb, { now: () => at, batch: 2 });
      expect(first.ran).toBe(true);
      expect(first.accounts).toBe(5);
      const again = await backfillAccountGrowthAll(odb, { now: () => at });
      expect(again).toEqual({
        id: ACCOUNT_GROWTH_BACKFILL_ID,
        ran: false,
        accounts: 0,
        granted: 0,
      });
      const forced = await backfillAccountGrowthAll(odb, { now: () => at, force: true });
      expect(forced.granted).toBe(0);

      expect(await grantsOf(odb, vet.id)).toEqual(['level28', 'offlineCrypt1', 'offlineLevel10']);
      for (const o of others) expect(await grantsOf(odb, o.id)).toEqual(['offlineLevel10']);
      expect(await grantsOf(odb, newbie.id)).toEqual([]);
      const rows = await odb.select().from(accountGrowthGrants);
      expect(rows.every((r) => r.backfill && r.grantedAt.getTime() === T0)).toBe(true);
      const [audits] = await queryRows<{ n: number }>(
        odb,
        sql`select count(*)::int as n from audit_log where event = 'account.grow'`,
      );
      expect(Number(audits!.n)).toBe(rows.length);
    } finally {
      await own.close();
    }
  });
});
