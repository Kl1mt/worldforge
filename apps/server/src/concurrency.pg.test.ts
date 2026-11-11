/**
 * Concurrency tests against a real PostgreSQL server (ticket 1.9).
 *
 * The other server tests use PGlite, which runs one transaction at a time, so their race tests
 * check the logic but not true parallelism. These run the same races with a connection pool, so
 * transactions really overlap and the row locks (`SELECT … FOR UPDATE`) and unique indexes are
 * what keep the data consistent.
 *
 * Runs when `DATABASE_URL` is set (it creates and drops a throwaway database next to it; see
 * `createPostgresTestDatabase`), and is skipped otherwise. CI sets `REQUIRE_PG_TESTS=1` in the
 * job with the Postgres service, so there a missing URL fails instead of skipping.
 *
 *   DATABASE_URL=postgres://worldforge:worldforge@127.0.0.1:5432/worldforge \
 *     pnpm --filter @worldforge/server test:pg
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  CONTRACT_TEMPLATES,
  attemptUpgrade,
  createRng,
  generateItem,
  generateTargetedItem,
  improveAffix,
  rerollAffix,
  salvageYield,
  sellPrice,
} from '@worldforge/game-core';
import { buildApp } from './app.js';
import { SESSION_COOKIE } from './auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from './activity/settle.js';
import {
  accounts,
  activities,
  auditLog,
  characterMaterials,
  characterProfessions,
  characterQuests,
  characters,
  dungeonRuns,
  itemInstances,
  merchantPurchases,
} from './db/schema.js';
import { transactionStats, withTransaction } from './db/transaction.js';
import type { DatabaseHandle } from './db/types.js';
import { uuidv7 } from './db/uuid.js';
import { createPostgresTestDatabase } from './test/db.js';
import { makeCryptReady } from './test/dungeon.js';
import { isPackItem } from './inventory/location.js';
import { recordQuestEventsTx } from './quests/store.js';
import { loadRollups, reconcileWithAudit, sumRollups } from './telemetry/report.js';
import { NAME_SAFE_LETTERS } from './test/names.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Concurrent requests per race. Below the pool size, so they really run in parallel. */
const N = 8;

describe.skipIf(!url)('real PostgreSQL concurrency', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2026-11-01T12:00:00Z');
  const advance = (ms: number) => {
    nowMs += ms;
  };

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 2 });
    app = buildApp({
      database,
      auth: {
        registerRateLimit: { max: 10_000, timeWindowMs: 60_000 },
        loginRateLimit: { max: 10_000, timeWindowMs: 60_000 },
      },
      activity: {
        ...DEFAULT_ACTIVITY_OPTIONS,
        offlineCapMs: 3 * HOUR,
        now: () => new Date(nowMs),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  let seq = 0;
  const unique = () => {
    seq += 1;
    let n = seq;
    let s = '';
    do {
      s = NAME_SAFE_LETTERS[n % NAME_SAFE_LETTERS.length]! + s;
      n = Math.floor(n / NAME_SAFE_LETTERS.length);
    } while (n > 0);
    return s;
  };

  interface Player {
    token: string;
    accountId: string;
  }

  const registerBody = (tag = unique()) => ({
    email: `racer-${tag}@graumark.test`,
    displayName: `Racer ${tag}`,
    password: 'ashes-and-iron-42',
  });

  async function newPlayer(): Promise<Player> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerBody(),
    });
    const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    if (!token) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
    return { token, accountId: res.json<{ account: { id: string } }>().account.id };
  }

  const call = (p: Player, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) =>
    app.inject({
      method,
      url: path,
      ...(payload ? { payload } : {}),
      cookies: { [SESSION_COOKIE]: p.token },
    });

  const createCharacter = (p: Player, name = `Racer${unique()}`) =>
    call(p, 'POST', '/api/characters', { name, classId: 'warrior', appearance: { banner: 'ash' } });

  async function newCharacter(p: Player): Promise<string> {
    const res = await createCharacter(p);
    if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
    return res.json<{ character: { id: string } }>().character.id;
  }

  async function farmer() {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const res = await call(p, 'POST', `/api/characters/${id}/activity`, {
      areaId: 'abandonedFields',
    });
    expect(res.statusCode).toBe(201);
    return { p, id };
  }

  async function grant(characterId: string, baseId: string, seed: number): Promise<string> {
    const item = generateItem({ seed, itemLevel: 5, baseId, rarityId: 'common' })!;
    const id = uuidv7();
    await database.db.insert(itemInstances).values({ id, characterId, ...item, source: 'test' });
    return id;
  }

  const rewardAudits = (characterId: string) =>
    database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, 'activity.reward')));

  /** Sums what the audit log says was granted, to compare with the character row. */
  async function audited(characterId: string) {
    const rows = await rewardAudits(characterId);
    const data = rows.map((r) => r.data as { creditedMs: number; gold: number; items: number });
    return {
      settlements: rows.length,
      creditedMs: data.reduce((s, d) => s + d.creditedMs, 0),
      gold: data.reduce((s, d) => s + d.gold, 0),
      items: data.reduce((s, d) => s + d.items, 0),
    };
  }

  it('runs transactions in parallel (sanity check for the races below)', async () => {
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withTransaction(database.db, (tx) => tx.execute(sql`select pg_sleep(0.5)`)),
      ),
    );
    // Serial execution would take ≥ 2 s; parallel takes 0.5 s plus overhead, which a slow
    // runner can stretch, so the bound sits between the two with room on both sides.
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it('credits a settlement window once under concurrent settles', async () => {
    const { p, id } = await farmer();
    advance(2 * HOUR);
    const results = await Promise.all(
      Array.from({ length: N }, () => call(p, 'POST', `/api/characters/${id}/activity/settle`)),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
    // Exactly one response carries the rewards; the summary is drained once.
    const withXp = results.filter((r) => r.json().summary.xpGained > 0);
    expect(withXp).toHaveLength(1);

    const sums = await audited(id);
    expect(sums.settlements).toBe(1);
    expect(sums.creditedMs).toBe(2 * HOUR);
    const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
    expect(c!.gold).toBe(sums.gold);
    const items = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, id));
    expect(items).toHaveLength(sums.items);
  });

  it('grants materials and profession XP once under concurrent settles (ticket 2.3)', async () => {
    const racer = await farmer();
    const twin = await farmer();
    await database.db
      .update(activities)
      .set({ seedSecret: 'pg-gather-race' })
      .where(sql`${activities.characterId} in (${racer.id}, ${twin.id})`);
    advance(2 * HOUR);
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        call(racer.p, 'POST', `/api/characters/${racer.id}/activity/settle`),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
    const withMaterials = results.filter(
      (r) => Object.keys(r.json().summary.materials ?? {}).length > 0,
    );
    expect(withMaterials).toHaveLength(1);
    expect(
      (await call(twin.p, 'POST', `/api/characters/${twin.id}/activity/settle`)).statusCode,
    ).toBe(200);

    const held = async (id: string) => ({
      materials: await database.db
        .select({
          materialId: characterMaterials.materialId,
          quantity: characterMaterials.quantity,
        })
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, id))
        .orderBy(characterMaterials.materialId),
      professions: await database.db
        .select({
          professionId: characterProfessions.professionId,
          level: characterProfessions.level,
          experience: characterProfessions.experience,
        })
        .from(characterProfessions)
        .where(eq(characterProfessions.characterId, id))
        .orderBy(characterProfessions.professionId),
    });
    const [raced, serial] = [await held(racer.id), await held(twin.id)];
    expect(raced.materials.length).toBeGreaterThan(0);
    // Same seed, same window: the race granted exactly what one settlement grants.
    expect(raced).toEqual(serial);
    const audits = await rewardAudits(racer.id);
    expect(audits).toHaveLength(1);
    expect(Object.fromEntries(raced.materials.map((m) => [m.materialId, m.quantity]))).toEqual(
      (audits[0]!.data as { materials: unknown }).materials,
    );
  });

  it('never credits time twice when settle, stop and start race', async () => {
    const { p, id } = await farmer();
    advance(HOUR);
    const base = `/api/characters/${id}/activity`;
    await Promise.all([
      call(p, 'POST', `${base}/settle`),
      call(p, 'POST', `${base}/stop`),
      call(p, 'POST', `${base}/settle`),
      call(p, 'POST', base, { areaId: 'abandonedFields' }),
      call(p, 'POST', `${base}/stop`),
    ]);
    const sums = await audited(id);
    expect(sums.creditedMs).toBe(HOUR);
    const rows = await database.db.select().from(activities).where(eq(activities.characterId, id));
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('never credits time twice when area switches and settles race (ticket 2.2)', async () => {
    const { p, id } = await farmer();
    await database.db.update(characters).set({ level: 10 }).where(eq(characters.id, id));
    advance(HOUR + 1_234);
    const base = `/api/characters/${id}/activity`;
    const targets = ['crowwood', 'oldBurialGrounds', 'abandonedFields', 'crowwood'] as const;
    const results = await Promise.all([
      ...targets.map((areaId) => call(p, 'POST', base, { areaId })),
      call(p, 'POST', `${base}/settle`),
      call(p, 'POST', `${base}/settle`),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual(Array(results.length).fill(200));
    const sums = await audited(id);
    expect(sums.creditedMs).toBe(HOUR + 1_234);
    const rows = await database.db.select().from(activities).where(eq(activities.characterId, id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Either the switch happened between cycles, or it is pending behind the cycle in progress.
    expect(['abandonedFields', 'crowwood', 'oldBurialGrounds']).toContain(row.areaId);
    if (row.pendingAreaId !== null) {
      expect(row.carryMs).toBeGreaterThan(0);
      expect(row.pendingAreaId).not.toBe(row.areaId);
    }
  });

  it('keeps one activity per account when starts race', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        call(p, 'POST', `/api/characters/${id}/activity`, { areaId: 'abandonedFields' }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([...Array(N - 1).fill(200), 201]);
    const rows = await database.db
      .select()
      .from(activities)
      .where(eq(activities.accountId, p.accountId));
    expect(rows).toHaveLength(1);
  });

  it('enforces the character slot limit under concurrent creates', async () => {
    const p = await newPlayer();
    const results = await Promise.all(Array.from({ length: N }, () => createCharacter(p)));
    const created = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode === 422);
    const [account] = await database.db.select().from(accounts).where(eq(accounts.id, p.accountId));
    expect(created).toHaveLength(account!.characterSlots);
    expect(refused).toHaveLength(N - account!.characterSlots);
    for (const r of refused) expect(r.json().error.code).toBe('no_free_slot');
    const rows = await database.db
      .select()
      .from(characters)
      .where(eq(characters.accountId, p.accountId));
    expect(rows).toHaveLength(account!.characterSlots);
  });

  it('gives a character name to exactly one of several accounts racing for it', async () => {
    const players = await Promise.all(Array.from({ length: 4 }, () => newPlayer()));
    const name = `Contested${unique()}`;
    const results = await Promise.all(players.map((p) => createCharacter(p, name)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
  });

  it('registers an email once under concurrent registrations', async () => {
    const body = registerBody();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { ...body, displayName: `${body.displayName} ${i}` },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
  });

  it('keeps one item per slot when equips race', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const helms = await Promise.all([1, 2, 3, 4, 5, 6].map((s) => grant(id, 'iron-helm', s)));
    const results = await Promise.all(
      helms.map((h) => call(p, 'POST', `/api/characters/${id}/items/${h}/equip`, { slot: 'head' })),
    );
    for (const r of results) expect([200, 409]).toContain(r.statusCode);
    const equipped = await database.db
      .select()
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, id), isNotNull(itemInstances.equippedSlot)));
    expect(equipped).toHaveLength(1);
    expect(equipped[0]!.equippedSlot).toBe('head');
  });

  it('keeps both ring slots consistent when ring moves race', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const rings = await Promise.all([1, 2, 3].map((s) => grant(id, 'iron-ring', s)));
    const ops = rings.flatMap((r) => [
      call(p, 'POST', `/api/characters/${id}/items/${r}/equip`, { slot: 'ring1' }),
      call(p, 'POST', `/api/characters/${id}/items/${r}/equip`, { slot: 'ring2' }),
    ]);
    for (const r of await Promise.all(ops)) expect([200, 409]).toContain(r.statusCode);
    const equipped = await database.db
      .select()
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, id), isNotNull(itemInstances.equippedSlot)));
    const slots = equipped.map((i) => i.equippedSlot).sort();
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots.every((s) => s === 'ring1' || s === 'ring2')).toBe(true);
  });

  it('settle racing equip, unequip and discard: no lost, duplicated or doubly credited value', async () => {
    const { p, id } = await farmer();
    const sword = await grant(id, 'longsword-notched', 11);
    const helm = await grant(id, 'iron-helm', 12);
    const junk = await grant(id, 'iron-ring', 13);
    advance(HOUR);
    const items = `/api/characters/${id}/items`;
    const results = await Promise.all([
      call(p, 'POST', `/api/characters/${id}/activity/settle`),
      call(p, 'POST', `${items}/${sword}/equip`),
      call(p, 'POST', `/api/characters/${id}/activity/settle`),
      call(p, 'POST', `${items}/${helm}/equip`),
      call(p, 'DELETE', `${items}/${junk}`),
      call(p, 'DELETE', `${items}/${junk}`),
      call(p, 'POST', `${items}/${helm}/unequip`),
      call(p, 'POST', `/api/characters/${id}/activity/settle`),
    ]);
    for (const r of results) expect([200, 404]).toContain(r.statusCode);
    // The second discard of the same item finds nothing.
    const discards = results.slice(4, 6).map((r) => r.statusCode);
    expect(discards.sort()).toEqual([200, 404]);

    const sums = await audited(id);
    expect(sums.creditedMs).toBe(HOUR);
    const owned = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, id));
    // Granted 3, discarded 1, plus whatever the (single) credited hour dropped.
    expect(owned).toHaveLength(3 - 1 + sums.items);
    expect(owned.find((i) => i.id === junk)).toBeUndefined();
    expect(owned.find((i) => i.id === sword)?.equippedSlot).toBe('weapon');
    const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
    expect(c!.gold).toBe(sums.gold);
    const discardAudits = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, id), eq(auditLog.event, 'item.discard')));
    expect(discardAudits).toHaveLength(1);
  });

  describe('dungeon runs (ticket 2.5)', () => {
    const claim = (p: Player, id: string, key: string) =>
      app.inject({
        method: 'POST',
        url: `/api/characters/${id}/dungeon/claim`,
        headers: { 'idempotency-key': key },
        cookies: { [SESSION_COOKIE]: p.token },
      });

    async function finishedRun() {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await makeCryptReady(database.db, id, 'warrior', 16);
      const res = await call(p, 'POST', `/api/characters/${id}/dungeon`, {
        dungeonId: 'namelessCrypt',
      });
      expect(res.statusCode).toBe(201);
      nowMs = Math.max(nowMs, Date.parse(res.json<{ run: { endsAt: string } }>().run.endsAt));
      return { p, id };
    }

    async function granted(characterId: string) {
      const items = await database.db
        .select({ id: itemInstances.id })
        .from(itemInstances)
        .where(
          and(
            eq(itemInstances.characterId, characterId),
            inArray(itemInstances.source, ['dungeon:namelessCrypt', 'hoard:namelessCrypt']),
          ),
        );
      const [seal] = await database.db
        .select({ quantity: characterMaterials.quantity })
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, characterId));
      const claims = await database.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, 'dungeon.claim')));
      const [c] = await database.db.select().from(characters).where(eq(characters.id, characterId));
      return {
        items: items.length,
        seal: seal?.quantity ?? 0,
        claims: claims.length,
        gold: c!.gold,
      };
    }

    it('grants a run once when claims with different keys race', async () => {
      const { p, id } = await finishedRun();
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => claim(p, id, `race-claim-${id}-${i}`)),
      );
      const ok = results.filter((r) => r.statusCode === 200);
      expect(ok).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        expect(r.json()).toMatchObject({ error: { code: 'no_dungeon_run' } });
      }
      const result = ok[0]!.json<{ result: { items: unknown[]; goldGained: number } }>().result;
      expect(await granted(id)).toEqual({
        items: result.items.length,
        seal: 1,
        claims: 1,
        gold: result.goldGained,
      });
    });

    it('replays one stored response when claims with the same key race', async () => {
      const { p, id } = await finishedRun();
      const results = await Promise.all(
        Array.from({ length: N }, () => claim(p, id, `same-claim-${id}`)),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
      for (const r of results) expect(r.json()).toEqual(results[0]!.json());
      const result = results[0]!.json<{ result: { items: unknown[]; goldGained: number } }>()
        .result;
      expect(await granted(id)).toEqual({
        items: result.items.length,
        seal: 1,
        claims: 1,
        gold: result.goldGained,
      });
    });

    it('tier III (ticket 3.6): racing claims and re-entries grant once and clear the tier once', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await makeCryptReady(database.db, id, 'warrior', 22, { rarityId: 'legendary' });
      await database.db
        .update(characters)
        .set({ progress: { gravewardenDefeated: true, cryptTierCleared: 2 } })
        .where(eq(characters.id, id));
      const res = await call(p, 'POST', `/api/characters/${id}/dungeon`, {
        dungeonId: 'namelessCrypt',
        tier: 3,
      });
      expect(res.statusCode).toBe(201);
      const run = res.json<{ run: { id: string; tier: number; endsAt: string } }>().run;
      expect(run.tier).toBe(3);
      nowMs = Math.max(nowMs, Date.parse(run.endsAt));
      const results = await Promise.all([
        ...Array.from({ length: N }, (_, i) => claim(p, id, `tier3-claim-${id}-${i}`)),
        call(p, 'POST', `/api/characters/${id}/dungeon`, { dungeonId: 'namelessCrypt', tier: 1 }),
        call(p, 'POST', `/api/characters/${id}/dungeon`, { dungeonId: 'namelessCrypt', tier: 3 }),
      ]);
      const claims = results.slice(0, N);
      const entries = results.slice(N);
      const ok = claims.filter((r) => r.statusCode === 200);
      expect(ok).toHaveLength(1);
      // An entry either lost to the open run or came after the claim; never two open runs.
      for (const r of entries) expect([201, 409]).toContain(r.statusCode);
      const reentered = entries.filter((r) => r.statusCode === 201).length;
      expect(reentered).toBeLessThanOrEqual(1);
      // A losing claim finds no run, or, if a re-entry opened a new run after the winning
      // claim, finds that run still in progress.
      const losingCodes = reentered ? ['no_dungeon_run', 'run_in_progress'] : ['no_dungeon_run'];
      for (const r of claims.filter((x) => x.statusCode !== 200)) {
        expect(losingCodes).toContain(r.json<{ error: { code: string } }>().error.code);
      }
      const open = await database.db
        .select()
        .from(dungeonRuns)
        .where(and(eq(dungeonRuns.characterId, id), isNull(dungeonRuns.claimedAt)));
      expect(open.length).toBe(entries.filter((r) => r.statusCode === 201).length);
      const result = ok[0]!.json<{
        result: {
          tier: number;
          items: unknown[];
          goldGained: number;
          bossDefeated: boolean;
          firstTierClear: boolean;
        };
      }>().result;
      expect(result.tier).toBe(3);
      expect(result.firstTierClear).toBe(result.bossDefeated);
      expect(await granted(id)).toEqual({
        items: result.items.length,
        seal: result.bossDefeated ? 1 : 0,
        claims: 1,
        gold: result.goldGained,
      });
      const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
      expect(c!.progress).toEqual({
        gravewardenDefeated: true,
        cryptTierCleared: result.bossDefeated ? 3 : 2,
      });
      const [claimAudit] = await database.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.characterId, id), eq(auditLog.event, 'dungeon.claim')));
      expect(claimAudit!.data).toMatchObject({ tier: 3, runId: run.id });
    });

    it('never lets a run and farming coexist when dungeon and farming starts race', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await makeCryptReady(database.db, id, 'warrior', 16);
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          i % 2 === 0
            ? call(p, 'POST', `/api/characters/${id}/dungeon`, { dungeonId: 'namelessCrypt' })
            : call(p, 'POST', `/api/characters/${id}/activity`, { areaId: 'abandonedFields' }),
        ),
      );
      for (const r of results) expect([200, 201, 409]).toContain(r.statusCode);
      const runs = await database.db
        .select()
        .from(dungeonRuns)
        .where(eq(dungeonRuns.accountId, p.accountId));
      expect(runs).toHaveLength(1);
      const farming = await database.db
        .select()
        .from(activities)
        .where(eq(activities.accountId, p.accountId));
      expect(farming).toEqual([]);
    });
  });

  // Ticket 2.6: merchant and forge. Every request carries its own Idempotency-Key unless a test
  // races one key on purpose.
  const keyed = (p: Player, path: string, payload: object, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: path,
      payload,
      headers: { 'idempotency-key': key },
      cookies: { [SESSION_COOKIE]: p.token },
    });
  const goldOf = async (id: string) =>
    (await database.db.select().from(characters).where(eq(characters.id, id)))[0]!.gold;
  const setGold = (id: string, gold: number) =>
    database.db.update(characters).set({ gold }).where(eq(characters.id, id));
  const eventsOf = (id: string, event: string) =>
    database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, id), eq(auditLog.event, event)));

  it('sells an item once when sells with different keys race (ticket 2.6)', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const item = await grant(id, 'iron-helm', 1);
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        keyed(p, `/api/characters/${id}/merchant/sell`, { itemIds: [item] }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, ...Array(N - 1).fill(404)]);
    expect(await goldOf(id)).toBe(sellPrice({ rarityId: 'common', itemLevel: 5 }));
    expect(await eventsOf(id, 'merchant.sell')).toHaveLength(1);
  });

  it('runs a request once when the same Idempotency-Key races; the rest replay it', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const items = await Promise.all([1, 2, 3].map((s) => grant(id, 'iron-helm', s)));
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        keyed(p, `/api/characters/${id}/merchant/sell`, { itemIds: items }, key),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
    const replayed = results.filter((r) => r.headers['idempotency-replayed'] === 'true');
    expect(replayed).toHaveLength(N - 1);
    for (const r of results) expect(r.json()).toEqual(results[0]!.json());
    expect(await goldOf(id)).toBe(3 * sellPrice({ rarityId: 'common', itemLevel: 5 }));
    expect(await eventsOf(id, 'merchant.sell')).toHaveLength(1);
  });

  it('sells a merchant offer once when buys race, and never spends gold twice', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    await setGold(id, 100_000);
    const stock = await call(p, 'GET', `/api/characters/${id}/merchant`);
    const offer = stock.json<{ offers: { offerId: string; price: number }[] }>().offers[0]!;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        keyed(p, `/api/characters/${id}/merchant/buy`, { offerId: offer.offerId }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, ...Array(N - 1).fill(409)]);
    expect(await goldOf(id)).toBe(100_000 - offer.price);
    const items = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, id));
    expect(items).toHaveLength(1);
    const bought = await database.db
      .select()
      .from(merchantPurchases)
      .where(eq(merchantPurchases.characterId, id));
    expect(bought).toHaveLength(1);
  });

  it('never lets racing buys spend more gold than the character has', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    await database.db.update(characters).set({ level: 20 }).where(eq(characters.id, id));
    const stock = await call(p, 'GET', `/api/characters/${id}/merchant`);
    const offers = stock.json<{ offers: { offerId: string; price: number }[] }>().offers;
    const cheapest = Math.min(...offers.map((o) => o.price));
    // Enough for any one affordable offer, never for two.
    const gold = 2 * cheapest - 1;
    await setGold(id, gold);
    const results = await Promise.all(
      offers.map((o) => keyed(p, `/api/characters/${id}/merchant/buy`, { offerId: o.offerId })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.statusCode !== 200)) {
      expect(r.json().error.code).toBe('insufficient_gold');
    }
    const left = await goldOf(id);
    expect(left).toBeGreaterThanOrEqual(0);
    const audits = await eventsOf(id, 'merchant.buy');
    expect(audits).toHaveLength(1);
    const paid = audits.reduce((s, a) => s + (a.data as { price: number }).price, 0);
    expect(left).toBe(gold - paid);
  });

  it('settle, sell, salvage and discard racing for one item: exactly one takes it', async () => {
    const { p, id } = await farmer();
    advance(10 * MIN);
    const item = await grant(id, 'barbute', 9);
    const [row] = await database.db.select().from(itemInstances).where(eq(itemInstances.id, item));
    const base = `/api/characters/${id}`;
    const results = await Promise.all([
      keyed(p, `${base}/merchant/sell`, { itemIds: [item] }),
      keyed(p, `${base}/forge/salvage`, { itemIds: [item] }),
      call(p, 'DELETE', `${base}/items/${item}`),
      keyed(p, `${base}/merchant/sell`, { itemIds: [item] }),
      keyed(p, `${base}/forge/salvage`, { itemIds: [item] }),
      call(p, 'POST', `${base}/activity/settle`),
    ]);
    const takers = results.slice(0, 5).filter((r) => r.statusCode === 200);
    expect(takers).toHaveLength(1);
    const sold = await eventsOf(id, 'merchant.sell');
    const salvaged = await eventsOf(id, 'forge.salvage');
    const discarded = await eventsOf(id, 'item.discard');
    expect(sold.length + salvaged.length + discarded.length).toBe(1);
    const rewards = await audited(id);
    const expectedGold =
      rewards.gold +
      (sold.length ? sellPrice(row!) : 0) +
      (salvaged.length ? salvageYield(row!).gold : 0);
    expect(await goldOf(id)).toBe(expectedGold);
    const remaining = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.id, item));
    expect(remaining).toHaveLength(0);
  });

  it('crafts only as often as the materials allow when crafts race', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    await setGold(id, 1_000);
    await database.db.insert(characterMaterials).values([
      { characterId: id, materialId: 'timber', quantity: 65 },
      { characterId: id, materialId: 'ashwort', quantity: 100 },
    ]);
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        keyed(p, `/api/characters/${id}/forge/craft`, {
          recipeId: 'fieldsmithWork',
          slot: 'head',
        }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(2);
    for (const r of results.filter((r) => r.statusCode !== 200)) {
      expect(r.json().error.code).toBe('insufficient_materials');
    }
    const mats = await database.db
      .select()
      .from(characterMaterials)
      .where(eq(characterMaterials.characterId, id));
    expect(Object.fromEntries(mats.map((m) => [m.materialId, m.quantity]))).toEqual({
      timber: 5,
      ashwort: 70,
    });
    expect(await goldOf(id)).toBe(940);
    const items = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, id));
    expect(items).toHaveLength(2);
  });

  // Runs last (tests in a file run in order). Retries keep the races correct, but each one is a
  // deadlock: before ticket 1.9 used `FOR NO KEY UPDATE` for the account/character locks, the
  // foreign-key checks of audit and activity inserts (`FOR KEY SHARE`) deadlocked against them
  // (start: account → character; stop/settle: character → account), about 4 per run.
  describe('quest turn-in (ticket 2.4)', () => {
    const turnIn = (p: Player, id: string, questRowId: string, key: string) =>
      app.inject({
        method: 'POST',
        url: `/api/characters/${id}/quests/${questRowId}/turn-in`,
        headers: { 'idempotency-key': key },
        cookies: { [SESSION_COOKIE]: p.token },
      });
    const turnInAudits = (characterId: string) =>
      database.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, 'quest.turn_in')));

    /** A character with the first story quest accepted and complete (not farming). */
    async function readyQuest() {
      const p = await newPlayer();
      const id = await newCharacter(p);
      const res = await call(p, 'POST', `/api/characters/${id}/quests`, {
        kind: 'story',
        questId: 'furrowsOfTheDead',
      });
      expect(res.statusCode).toBe(201);
      const [quest] = await database.db
        .select()
        .from(characterQuests)
        .where(eq(characterQuests.characterId, id));
      await withTransaction(database.db, (tx) =>
        recordQuestEventsTx(tx, id, [{ type: 'enemyKilled', enemyId: 'risenFarmhand', count: 12 }]),
      );
      return { p, id, questRowId: quest!.id };
    }

    it('grants a quest reward once under concurrent turn-ins (same and different keys)', async () => {
      const { p, id, questRowId } = await readyQuest();
      const keys = Array.from({ length: N }, (_, i) =>
        i % 2 === 0 ? 'shared-key-0001' : `own-key-${i}-xyz`,
      );
      const results = await Promise.all(keys.map((k) => turnIn(p, id, questRowId, k)));
      const shared = results.filter((_, i) => keys[i] === 'shared-key-0001');
      const own = results.filter((_, i) => keys[i] !== 'shared-key-0001');
      const winners = results.filter(
        (r) => r.statusCode === 200 && r.headers['idempotency-replayed'] !== 'true',
      );
      expect(winners).toHaveLength(1);
      // Every request with the shared key gets the same answer: all the stored success, or all
      // refused because another key won.
      const sharedCodes = new Set(shared.map((r) => r.statusCode));
      expect(sharedCodes.size).toBe(1);
      if (sharedCodes.has(200)) {
        // Equal as JSON (jsonb may store the replayed object with its keys in another order).
        for (const r of shared) expect(r.json()).toEqual(shared[0]!.json());
        expect(own.every((r) => r.statusCode === 409)).toBe(true);
      } else {
        expect(own.filter((r) => r.statusCode === 200)).toHaveLength(1);
      }
      expect(await turnInAudits(id)).toHaveLength(1);
      const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
      expect(c!.gold).toBe(40);
      const [q] = await database.db
        .select()
        .from(characterQuests)
        .where(eq(characterQuests.id, questRowId));
      expect(q!.status).toBe('turnedIn');
    });

    it('settles racing turn-ins credit kills to the quest once and grant once', async () => {
      const { p, id } = await farmer();
      const accepted = await call(p, 'POST', `/api/characters/${id}/quests`, {
        kind: 'story',
        questId: 'furrowsOfTheDead',
      });
      expect(accepted.statusCode).toBe(201);
      const [quest] = await database.db
        .select()
        .from(characterQuests)
        .where(eq(characterQuests.characterId, id));
      advance(HOUR);
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          i % 2 === 0
            ? call(p, 'POST', `/api/characters/${id}/activity/settle`)
            : turnIn(p, id, quest!.id, `mixed-key-${i}-abc`),
        ),
      );
      expect(results.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);
      expect(results.filter((r) => r.statusCode === 200 && r.json().reward)).toHaveLength(1);
      expect(await turnInAudits(id)).toHaveLength(1);
      // Gold = what the audited settlements granted + the quest's 40, once.
      const sums = await audited(id);
      const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
      expect(c!.gold).toBe(sums.gold + 40);
      expect(sums.creditedMs).toBe(HOUR);
    });
  });

  // Ticket 2.8: races across features on one character. Every value endpoint locks the character
  // row first, so they serialise; these check that no combination loses or doubles gold, items or
  // materials, by reconciling the rows with the audit log.
  describe('cross-feature races (ticket 2.8)', () => {
    /** Gold, item and material deltas the audit log records for a character. */
    async function ledger(characterId: string) {
      const rows = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.characterId, characterId));
      let gold = 0;
      let items = 0;
      const materials: Record<string, number> = {};
      const add = (bundle: unknown, sign = 1) => {
        for (const [k, n] of Object.entries((bundle ?? {}) as Record<string, number>)) {
          materials[k] = (materials[k] ?? 0) + sign * n;
        }
      };
      for (const { event, data } of rows) {
        const d = data as Record<string, unknown> & { gold: number };
        if (event === 'activity.reward' || event === 'dungeon.claim') {
          gold += d.gold;
          items += d.items as number;
          add(d.materials);
        } else if (event === 'merchant.buy') {
          gold -= d.price as number;
          items += 1;
        } else if (event === 'merchant.sell') {
          gold += d.gold;
          items -= (d.items as unknown[]).length;
        } else if (event === 'forge.salvage') {
          gold += d.gold;
          items -= (d.items as unknown[]).length;
          add(d.materials);
        } else if (event === 'forge.craft') {
          gold -= d.gold;
          items += 1;
          add(d.materials, -1);
        } else if (event === 'quest.turn_in') {
          gold += d.gold;
          items += d.item ? 1 : 0;
          add(d.materials);
        } else if (event.startsWith('forge.') && event !== 'forge.salvage') {
          // Ticket 3.9: upgrades, rerolls and improvements spend gold and materials.
          if (event !== 'forge.craft') {
            gold -= d.gold;
            add(d.materials, -1);
          }
        }
      }
      return { gold, items, materials };
    }

    async function holdings(characterId: string) {
      const [c] = await database.db.select().from(characters).where(eq(characters.id, characterId));
      const items = await database.db
        .select({ id: itemInstances.id })
        .from(itemInstances)
        .where(eq(itemInstances.characterId, characterId));
      const mats = await database.db
        .select()
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, characterId));
      return {
        gold: c!.gold,
        items: items.length,
        materials: Object.fromEntries(
          mats.filter((m) => m.quantity > 0).map((m) => [m.materialId, m.quantity]),
        ),
      };
    }

    /** A complete, active quest worth 50 gold (inserted: the races are about the turn-in). */
    async function readyQuestRow(characterId: string): Promise<string> {
      const id = uuidv7();
      await database.db.insert(characterQuests).values({
        id,
        characterId,
        kind: 'story',
        questId: 'furrowsOfTheDead',
        objectives: [{ kind: 'kill', enemyId: 'risenFarmhand', count: 1 }],
        progress: [1],
        reward: { xp: 10, gold: 50, materials: { timber: 2 }, item: null },
        acceptedAt: new Date(nowMs),
      });
      return id;
    }

    const STARTING_GOLD = 10_000;

    it('a crypt claim racing sells, salvages, a buy and a turn-in: everything reconciles', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await makeCryptReady(database.db, id, 'warrior', 16);
      const loose = [];
      for (let i = 0; i < 4; i++) loose.push(await grant(id, 'iron-helm', 100 + i));
      const questRowId = await readyQuestRow(id);
      await setGold(id, STARTING_GOLD);
      const before = await holdings(id);
      const stock = await call(p, 'GET', `/api/characters/${id}/merchant`);
      const offer = stock.json<{ offers: { offerId: string }[] }>().offers[0]!;
      const entered = await call(p, 'POST', `/api/characters/${id}/dungeon`, {
        dungeonId: 'namelessCrypt',
      });
      expect(entered.statusCode).toBe(201);
      nowMs = Math.max(nowMs, Date.parse(entered.json<{ run: { endsAt: string } }>().run.endsAt));

      const base = `/api/characters/${id}`;
      const results = await Promise.all([
        keyed(p, `${base}/dungeon/claim`, {}),
        keyed(p, `${base}/merchant/sell`, { itemIds: [loose[0]] }),
        keyed(p, `${base}/merchant/sell`, { itemIds: [loose[1]] }),
        keyed(p, `${base}/forge/salvage`, { itemIds: [loose[2]] }),
        keyed(p, `${base}/forge/salvage`, { itemIds: [loose[3]] }),
        keyed(p, `${base}/merchant/buy`, { offerId: offer.offerId }),
        keyed(p, `${base}/quests/${questRowId}/turn-in`, {}),
        keyed(p, `${base}/dungeon/claim`, {}),
      ]);
      // Every other action succeeds; exactly one of the two racing claims wins (either
      // may reach the row lock first) and the other finds the run claimed.
      const codes = results.map((r) => r.statusCode);
      expect(codes.slice(1, 7)).toEqual([200, 200, 200, 200, 200, 200]);
      expect([codes[0], codes[7]].sort()).toEqual([200, 409]);
      const after = await holdings(id);
      const audit = await ledger(id);
      expect(after.gold - before.gold).toBe(audit.gold);
      expect(after.items - before.items).toBe(audit.items);
      expect(after.materials).toEqual(audit.materials);
      expect(await eventsOf(id, 'dungeon.claim')).toHaveLength(1);
    });

    it('a crypt entry racing settles, a sell, a buy, a craft and a turn-in on a farming hero', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await makeCryptReady(database.db, id, 'warrior', 16);
      const start = await call(p, 'POST', `/api/characters/${id}/activity`, {
        areaId: 'blackwater',
      });
      expect(start.statusCode).toBe(201);
      const loose = await grant(id, 'iron-helm', 7);
      const questRowId = await readyQuestRow(id);
      await setGold(id, STARTING_GOLD);
      await database.db
        .insert(characterMaterials)
        .values([
          { characterId: id, materialId: 'timber', quantity: 30 },
          { characterId: id, materialId: 'ashwort', quantity: 15 },
        ])
        .onConflictDoUpdate({
          target: [characterMaterials.characterId, characterMaterials.materialId],
          set: { quantity: sql`excluded.quantity` },
        });
      const before = await holdings(id);
      const stock = await call(p, 'GET', `/api/characters/${id}/merchant`);
      const offer = stock.json<{ offers: { offerId: string }[] }>().offers[0]!;
      advance(HOUR);

      const base = `/api/characters/${id}`;
      const results = await Promise.all([
        call(p, 'POST', `${base}/dungeon`, { dungeonId: 'namelessCrypt' }),
        call(p, 'POST', `${base}/activity/settle`),
        call(p, 'POST', `${base}/activity/settle`),
        keyed(p, `${base}/merchant/sell`, { itemIds: [loose] }),
        keyed(p, `${base}/merchant/buy`, { offerId: offer.offerId }),
        keyed(p, `${base}/forge/craft`, { recipeId: 'fieldsmithWork', slot: 'ring' }),
        keyed(p, `${base}/quests/${questRowId}/turn-in`, {}),
      ]);
      expect(results[0]!.statusCode).toBe(201);
      // A settle after the entry finds no activity (409); one before it settles normally.
      for (const r of results.slice(1, 3)) expect([200, 409]).toContain(r.statusCode);
      // The sell and the turn-in (no item reward) always go through. The buy and the craft each
      // add an item, so they go through unless the hour's drops filled the pack first: about 1
      // hero in 1,000 ends the hour at the 60-slot capacity (F.6, Flake hunt 2026-11-10). Then
      // the refusal must be `inventory_full`, and the pack must really have been full: after a
      // refusal only the sell can free a slot, so the pack ends at most one below capacity.
      const [sell, buy, craft, turnIn] = results.slice(3);
      expect([sell!.statusCode, turnIn!.statusCode]).toEqual([200, 200]);
      const refused = [buy!, craft!].filter((r) => r.statusCode !== 200);
      for (const r of refused) {
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json<{ error: { code: string } }>().error.code).toBe('inventory_full');
      }
      if (refused.length > 0) {
        const capacity = DEFAULT_ACTIVITY_OPTIONS.rules.inventory.capacity;
        const items = await database.db
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.characterId, id));
        expect(items.filter(isPackItem).length).toBeGreaterThanOrEqual(capacity - 1);
      }

      const after = await holdings(id);
      const audit = await ledger(id);
      expect(after.gold - before.gold).toBe(audit.gold);
      expect(after.items - before.items).toBe(audit.items);
      for (const [k, n] of Object.entries(audit.materials)) {
        expect((after.materials[k] ?? 0) - (before.materials[k] ?? 0)).toBe(n);
      }
      // The hour of farming was credited exactly once, and farming has ended.
      const sums = await audited(id);
      expect(sums.creditedMs).toBe(HOUR);
      const farming = await database.db
        .select()
        .from(activities)
        .where(eq(activities.characterId, id));
      expect(farming).toEqual([]);
    });

    describe('Phase 3 (ticket 3.9)', () => {
      /** A level-20 hero in Legendary gear with tier I cleared, a full pack and forge stock. */
      async function lateGameHero() {
        const p = await newPlayer();
        const id = await newCharacter(p);
        await makeCryptReady(database.db, id, 'warrior', 20, { rarityId: 'legendary' });
        await database.db
          .update(characters)
          .set({ progress: { gravewardenDefeated: true, cryptTierCleared: 1 } })
          .where(eq(characters.id, id));
        await setGold(id, STARTING_GOLD * 10);
        await database.db
          .insert(characterMaterials)
          .values(
            (['timber', 'rawHide', 'ironOre', 'soulShard', 'ashwort'] as const).map(
              (materialId) => ({ characterId: id, materialId, quantity: 10_000 }),
            ),
          );
        // The forged item, then filler up to the 60-slot capacity: the claim's drops find no
        // room, so Legendaries and set pieces are kept over capacity (B.2) and the rest
        // overflow-salvaged, unless a racing sell or the filter frees room first.
        const forged = generateItem({
          seed: 77,
          itemLevel: 18,
          baseId: 'barbute',
          rarityId: 'epic',
          classId: 'warrior',
        })!;
        const itemId = uuidv7();
        await database.db
          .insert(itemInstances)
          .values({ id: itemId, characterId: id, ...forged, source: 'test' });
        const filler = generateItem({
          seed: 5,
          itemLevel: 5,
          baseId: 'iron-helm',
          rarityId: 'common',
        })!;
        await database.db.insert(itemInstances).values(
          Array.from({ length: 59 }, () => ({
            id: uuidv7(),
            characterId: id,
            ...filler,
            source: 'test',
          })),
        );
        return { p, id, itemId };
      }

      /** A complete targeted Abbey contract (inserted: the race is about the turn-in). */
      async function readyTargetedContract(characterId: string): Promise<string> {
        const template = CONTRACT_TEMPLATES.find((t) => t.areaId === 'sunkenAbbey')!;
        const id = uuidv7();
        await database.db.insert(characterQuests).values({
          id,
          characterId,
          kind: 'contract',
          questId: template.id,
          contractDay: new Date(nowMs).toISOString().slice(0, 10),
          contractSlot: 0,
          objectives: [template.objective],
          progress: ['count' in template.objective ? template.objective.count : 1],
          reward: {
            xp: 100,
            gold: 120,
            materials: {},
            item: {
              slot: 'ring',
              rarityId: 'epic',
              itemLevel: 20,
              lootTableId: 'sunkenAbbey',
              seed: 4242,
            },
          },
          acceptedAt: new Date(nowMs),
        });
        return id;
      }

      it('a tier II claim, forge work, sell, salvage, lock, a filter change and a targeted turn-in on one item: everything reconciles', async () => {
        for (let round = 0; round < 3; round++) {
          const { p, id, itemId } = await lateGameHero();
          const before = await holdings(id);
          const entered = await call(p, 'POST', `/api/characters/${id}/dungeon`, {
            dungeonId: 'namelessCrypt',
            tier: 2,
          });
          expect(entered.statusCode).toBe(201);
          nowMs = Math.max(
            nowMs,
            Date.parse(entered.json<{ run: { endsAt: string } }>().run.endsAt),
          );
          // Created after the entry so the pack is full when the claim counts it (the
          // turn-in needs a free slot, so it may lose with inventory_full; that is fine).
          const questRowId = await readyTargetedContract(id);
          const c = `/api/characters/${id}`;
          const filter = {
            rules: {
              action: 'sell',
              belowRarity: 'rare',
              wantedAffixes: [],
              wantedEffects: [],
              include: [],
            },
          };
          const named = [
            ['claim', keyed(p, `${c}/dungeon/claim`, {})],
            ['claim', keyed(p, `${c}/dungeon/claim`, {})],
            ['upgrade', keyed(p, `${c}/forge/upgrade`, { itemId })],
            ['reroll', keyed(p, `${c}/forge/reroll`, { itemId, affixIndex: 0 })],
            ['improve', keyed(p, `${c}/forge/improve`, { itemId, affixIndex: 0 })],
            ['sell', keyed(p, `${c}/merchant/sell`, { itemIds: [itemId] })],
            ['salvage', keyed(p, `${c}/forge/salvage`, { itemIds: [itemId] })],
            ['lock', call(p, 'POST', `${c}/items/${itemId}/lock`)],
            ['unlock', call(p, 'POST', `${c}/items/${itemId}/unlock`)],
            ['filter', call(p, 'POST', `${c}/loot-filter`, filter)],
            ['turnIn', keyed(p, `${c}/quests/${questRowId}/turn-in`, {})],
            ['turnIn', keyed(p, `${c}/quests/${questRowId}/turn-in`, {})],
          ] as const;
          const results = await Promise.all(named.map(([, r]) => r));
          const of = (name: string) =>
            results.filter((_, i) => named[i]![0] === name).map((r) => r.statusCode);
          const err = (r: (typeof results)[number]) =>
            r.statusCode === 200 ? 'ok' : `${r.statusCode} ${r.json().error.code}`;
          // No 5xx, no deadlock, nothing unexpected, whatever order the locks were taken in.
          for (const r of results) {
            expect(
              ['ok', '409 no_dungeon_run', '404 not_found', '409 item_locked'].concat([
                '422 inventory_full',
                '409 quest_already_turned_in',
                '422 affix_at_max',
                '422 improvement_cap',
              ]),
              `round ${round}`,
            ).toContain(err(r));
          }
          expect(of('claim').sort()).toEqual([200, 409]);
          // Lock and unlock answer 404 only when the item was already sold or salvaged.
          for (const name of ['lock', 'unlock']) {
            expect(of(name).every((code) => code === 200 || code === 404)).toBe(true);
          }
          expect(of('filter')).toEqual([200]);
          expect(of('turnIn').filter((s) => s === 200).length).toBeLessThanOrEqual(1);

          // The item left at most once, and only if no lock held it at that moment.
          const disposed =
            (await eventsOf(id, 'merchant.sell')).length +
            (await eventsOf(id, 'forge.salvage')).filter((a) =>
              (a.data as { items: { itemId: string }[] }).items.some((i) => i.itemId === itemId),
            ).length;
          const [row] = await database.db
            .select()
            .from(itemInstances)
            .where(eq(itemInstances.id, itemId));
          expect(disposed).toBe(row ? 0 : 1);
          // Each successful forge action used one draw of the item's stream, in counter order.
          const forgeRows = (
            await database.db
              .select()
              .from(auditLog)
              .where(
                and(
                  eq(auditLog.characterId, id),
                  sql`${auditLog.event} in ('forge.upgrade', 'forge.reroll', 'forge.improve')`,
                ),
              )
          ).map((a) => (a.data as { forgeCounter: number }).forgeCounter);
          const forgeOk = [...of('upgrade'), ...of('reroll'), ...of('improve')].filter(
            (s) => s === 200,
          ).length;
          expect(forgeRows.sort((a, b) => a - b)).toEqual(
            Array.from({ length: forgeOk }, (_, i) => i),
          );
          if (row) expect(row.forgeCounter).toBe(forgeOk);

          // Gold, items and materials all match the audit log, and the claim granted once.
          const after = await holdings(id);
          const audit = await ledger(id);
          expect(after.gold - before.gold, `round ${round}`).toBe(audit.gold);
          expect(after.items - before.items).toBe(audit.items);
          const delta = Object.fromEntries(
            Object.keys({ ...after.materials, ...before.materials })
              .map((k) => [
                k,
                (after.materials[k] ?? 0) - ((before.materials as Record<string, number>)[k] ?? 0),
              ])
              .filter(([, n]) => n !== 0),
          );
          expect(delta).toEqual(
            Object.fromEntries(Object.entries(audit.materials).filter(([, n]) => n !== 0)),
          );
          expect(await eventsOf(id, 'dungeon.claim')).toHaveLength(1);
          expect(await eventsOf(id, 'quest.turn_in')).toHaveLength(
            of('turnIn').filter((s) => s === 200).length,
          );
        }
      });

      it('racing turn-ins of a targeted contract grant one item, the one its stored seed fixed', async () => {
        const p = await newPlayer();
        const id = await newCharacter(p);
        // A hero who can reach the Abbey (ticket F.1: a contract's area must be open at turn-in).
        await database.db
          .update(characters)
          .set({ level: 20, progress: { gravewardenDefeated: true } })
          .where(eq(characters.id, id));
        const questRowId = await readyTargetedContract(id);
        const sameKey = randomUUID();
        const results = await Promise.all([
          ...Array.from({ length: N / 2 }, () =>
            keyed(p, `/api/characters/${id}/quests/${questRowId}/turn-in`, {}),
          ),
          ...Array.from({ length: N / 2 }, () =>
            keyed(p, `/api/characters/${id}/quests/${questRowId}/turn-in`, {}, sameKey),
          ),
        ]);
        const fresh = results.filter(
          (r) => r.statusCode === 200 && r.headers['idempotency-replayed'] !== 'true',
        );
        expect(fresh).toHaveLength(1);
        for (const r of results.filter((x) => x.statusCode !== 200)) {
          expect(r.json<{ error: { code: string } }>().error.code).toBe('quest_already_turned_in');
        }
        const granted = await database.db
          .select()
          .from(itemInstances)
          .where(and(eq(itemInstances.characterId, id), eq(itemInstances.source, 'quest')));
        expect(granted).toHaveLength(1);
        const expected = generateTargetedItem(
          { slot: 'ring', rarityId: 'epic', itemLevel: 20, lootTableId: 'sunkenAbbey' },
          4242,
          'warrior',
        )!;
        expect([granted[0]!.baseId, granted[0]!.seed]).toEqual([expected.baseId, expected.seed]);
        expect(await goldOf(id)).toBe(120);
      });
    });
  });

  describe('forge work (ticket 3.4)', () => {
    type Outcome = { success?: boolean; upgradeLevel?: number; upgradePity?: number };
    /** A forge audit row's data (`forge.upgrade` / `forge.reroll` / `forge.improve`). */
    interface Audited {
      event: string;
      forgeCounter: number;
      gold: number;
      materials: Record<string, number>;
      affixIndex?: number;
      success?: boolean;
      toLevel?: number;
    }
    const stock = async (id: string, gold = 1_000_000) => {
      await setGold(id, gold);
      await database.db.insert(characterMaterials).values(
        (['timber', 'rawHide', 'ironOre', 'soulShard'] as const).map((materialId) => ({
          characterId: id,
          materialId,
          quantity: 100_000,
        })),
      );
    };
    async function forgeable(
      characterId: string,
      extra: Partial<typeof itemInstances.$inferInsert> = {},
    ): Promise<string> {
      const item = generateItem({
        seed: 77,
        itemLevel: 14,
        baseId: 'barbute',
        rarityId: 'epic',
        classId: 'warrior',
      })!;
      const id = uuidv7();
      await database.db
        .insert(itemInstances)
        .values({ id, characterId, ...item, source: 'test', ...extra });
      return id;
    }
    const itemRow = async (id: string) =>
      (await database.db.select().from(itemInstances).where(eq(itemInstances.id, id)))[0];
    const materialsOf = async (id: string) =>
      Object.fromEntries(
        (
          await database.db
            .select()
            .from(characterMaterials)
            .where(eq(characterMaterials.characterId, id))
        ).map((m) => [m.materialId, m.quantity]),
      );
    const forgeAudits = async (id: string) =>
      (
        await database.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.characterId, id),
              sql`${auditLog.event} in ('forge.upgrade', 'forge.reroll', 'forge.improve')`,
            ),
          )
      )
        .map((a) => ({ event: a.event, ...(a.data as Record<string, unknown>) }) as Audited)
        .sort((a, b) => (a.forgeCounter as number) - (b.forgeCounter as number));
    /** Spending recorded in the audit log, to reconcile with the character row. */
    const spent = (rows: Awaited<ReturnType<typeof forgeAudits>>) => {
      const materials: Record<string, number> = {};
      let gold = 0;
      for (const r of rows) {
        gold += r.gold as number;
        for (const [k, n] of Object.entries(r.materials as Record<string, number>))
          materials[k] = (materials[k] ?? 0) + n;
      }
      return { gold, materials };
    };
    /**
     * Replays the audited actions in counter order through game-core from the item's starting
     * state: the stored item must be exactly that (one draw per counter value, none repeated).
     */
    function replay(
      start: NonNullable<Awaited<ReturnType<typeof itemRow>>>,
      rows: Awaited<ReturnType<typeof forgeAudits>>,
    ) {
      let item = { ...start };
      rows.forEach((r, i) => {
        expect(r.forgeCounter, 'counters are consecutive').toBe(start.forgeCounter + i);
        const rng = createRng(`${start.forgeSecret}:${r.forgeCounter as number}`);
        if (r.event === 'forge.upgrade') {
          const out = attemptUpgrade(item, rng);
          expect(r).toMatchObject({ success: out.success, toLevel: out.upgradeLevel });
          item = { ...item, upgradeLevel: out.upgradeLevel, upgradePity: out.upgradePity };
        } else if (r.event === 'forge.reroll') {
          const out = rerollAffix(item, r.affixIndex as number, 'warrior', rng);
          if (!out.ok) throw new Error(out.reason);
          item = { ...item, affixes: out.value, rerollCount: item.rerollCount + 1 };
        } else {
          const out = improveAffix(item, r.affixIndex as number, rng);
          if (!out.ok) throw new Error(out.reason);
          item = { ...item, affixes: out.value };
        }
      });
      return { ...item, forgeCounter: start.forgeCounter + rows.length };
    }

    it('racing upgrades of one item (different keys): each draw used once, all paid once', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await stock(id);
      const item = await forgeable(id, { upgradeLevel: 5 });
      const start = (await itemRow(item))!;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          keyed(p, `/api/characters/${id}/forge/upgrade`, { itemId: item }),
        ),
      );
      const ok = results.filter((r) => r.statusCode === 200);
      for (const r of results.filter((r) => r.statusCode !== 200)) {
        expect(r.json().error.code).toBe('max_upgrade');
      }
      const rows = await forgeAudits(id);
      expect(rows).toHaveLength(ok.length);
      const after = (await itemRow(item))!;
      const expected = replay(start, rows);
      expect(after).toMatchObject({
        upgradeLevel: expected.upgradeLevel,
        upgradePity: expected.upgradePity,
        forgeCounter: start.forgeCounter + ok.length,
      });
      // Every response reports a distinct draw; together they are the audit log.
      const outcomes = ok.map((r) => r.json<{ outcome: Outcome }>().outcome);
      expect(outcomes.filter((o) => o.success).length).toBe(rows.filter((r) => r.success).length);
      const paid = spent(rows);
      expect(await goldOf(id)).toBe(1_000_000 - paid.gold);
      const mats = await materialsOf(id);
      for (const [k, n] of Object.entries(paid.materials)) expect(mats[k]).toBe(100_000 - n);
    });

    it('the same key raced: one attempt, the rest replay its outcome', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await stock(id);
      const item = await forgeable(id, { upgradeLevel: 8 });
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          keyed(p, `/api/characters/${id}/forge/upgrade`, { itemId: item }, key),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
      expect(results.filter((r) => r.headers['idempotency-replayed'] === 'true')).toHaveLength(
        N - 1,
      );
      for (const r of results) expect(r.json()).toEqual(results[0]!.json());
      expect((await itemRow(item))!.forgeCounter).toBe(1);
      expect(await forgeAudits(id)).toHaveLength(1);
    });

    it('upgrades, rerolls and improvements racing on one item reconcile with a sequential replay', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      await stock(id);
      const item = await forgeable(id, { upgradeLevel: 2 });
      const start = (await itemRow(item))!;
      const base = `/api/characters/${id}/forge`;
      const results = await Promise.all([
        keyed(p, `${base}/upgrade`, { itemId: item }),
        keyed(p, `${base}/reroll`, { itemId: item, affixIndex: 0 }),
        keyed(p, `${base}/improve`, { itemId: item, affixIndex: 1 }),
        keyed(p, `${base}/upgrade`, { itemId: item }),
        keyed(p, `${base}/reroll`, { itemId: item, affixIndex: 2 }),
        keyed(p, `${base}/improve`, { itemId: item, affixIndex: 1 }),
        keyed(p, `${base}/upgrade`, { itemId: item }),
        keyed(p, `${base}/improve`, { itemId: item, affixIndex: 3 }),
      ]);
      for (const r of results) expect([200, 422]).toContain(r.statusCode);
      const rows = await forgeAudits(id);
      expect(rows).toHaveLength(results.filter((r) => r.statusCode === 200).length);
      const after = (await itemRow(item))!;
      const expected = replay(start, rows);
      expect(after.affixes).toEqual(expected.affixes);
      expect(after).toMatchObject({
        upgradeLevel: expected.upgradeLevel,
        upgradePity: expected.upgradePity,
        rerollCount: expected.rerollCount,
        forgeCounter: expected.forgeCounter,
      });
      expect(await goldOf(id)).toBe(1_000_000 - spent(rows).gold);
    });

    it('a forge action racing a sell and a salvage of the same item: one order wins, all reconciles', async () => {
      for (let round = 0; round < 4; round++) {
        const p = await newPlayer();
        const id = await newCharacter(p);
        await stock(id, 100_000);
        const item = await forgeable(id, { upgradeLevel: 3 });
        const before = (await itemRow(item))!;
        const c = `/api/characters/${id}`;
        const results = await Promise.all([
          keyed(p, `${c}/forge/upgrade`, { itemId: item }),
          keyed(p, `${c}/forge/reroll`, { itemId: item, affixIndex: 0 }),
          keyed(p, `${c}/merchant/sell`, { itemIds: [item] }),
          keyed(p, `${c}/forge/salvage`, { itemIds: [item] }),
          keyed(p, `${c}/forge/improve`, { itemId: item, affixIndex: 1 }),
          keyed(p, `${c}/forge/upgrade`, { itemId: item }),
        ]);
        const sold = await eventsOf(id, 'merchant.sell');
        const salvaged = await eventsOf(id, 'forge.salvage');
        expect(sold.length + salvaged.length, `round ${round}`).toBe(1);
        expect(await itemRow(item)).toBeUndefined();
        const rows = await forgeAudits(id);
        // A forge action after the item left finds no item (404); one before it may still be
        // refused by the rules (this item's second affix sits at its tier maximum). Neither pays.
        const forged = [0, 1, 4, 5].map((i) => results[i]!);
        expect(forged.filter((r) => r.statusCode === 200)).toHaveLength(rows.length);
        for (const r of forged.filter((r) => r.statusCode !== 200)) {
          expect([
            '404 not_found',
            '422 affix_at_max',
            '422 improvement_cap',
            '422 max_upgrade',
          ]).toContain(`${r.statusCode} ${r.json().error.code}`);
        }
        // Sale and salvage price the item as it was (upgrades are a sink, not refunded).
        const gain = sold.length ? sellPrice(before) : salvageYield(before).gold;
        expect(await goldOf(id)).toBe(100_000 - spent(rows).gold + gain);
      }
    });

    it('a forge action on an equipped item racing settles: settled once, forged once each', async () => {
      const { p, id } = await farmer();
      await stock(id, 100_000);
      const item = await forgeable(id, { upgradeLevel: 4, equippedSlot: 'head' });
      const start = (await itemRow(item))!;
      advance(20 * MIN);
      const c = `/api/characters/${id}`;
      const results = await Promise.all([
        call(p, 'POST', `${c}/activity/settle`),
        keyed(p, `${c}/forge/upgrade`, { itemId: item }),
        call(p, 'POST', `${c}/activity/settle`),
        keyed(p, `${c}/forge/improve`, { itemId: item, affixIndex: 0 }),
        call(p, 'POST', `${c}/activity/settle`),
        keyed(p, `${c}/forge/upgrade`, { itemId: item }),
      ]);
      for (const r of results) expect([200, 422]).toContain(r.statusCode);
      const rewards = await audited(id);
      // Started 0 min ago + 20 min: exactly 20 minutes credited, whoever settled.
      expect(rewards.creditedMs).toBe(20 * MIN);
      const rows = await forgeAudits(id);
      const after = (await itemRow(item))!;
      const expected = replay(start, rows);
      expect(after).toMatchObject({
        upgradeLevel: expected.upgradeLevel,
        forgeCounter: expected.forgeCounter,
      });
      expect(after.affixes).toEqual(expected.affixes);
      expect(await goldOf(id)).toBe(100_000 + rewards.gold - spent(rows).gold);
    });
  });

  describe('loot filter & item lock (ticket 3.7)', () => {
    const filterRules = {
      action: 'salvage',
      belowRarity: 'rare',
      wantedAffixes: [],
      wantedEffects: [],
      include: [],
    } as const;
    type RewardData = {
      creditedMs: number;
      gold: number;
      items: number;
      itemsSalvaged: number;
      filtered?: { gold: number; items: { seed: number; rarityId: string }[] };
    };
    const rewardsOf = async (id: string) =>
      (await rewardAudits(id)).map((r) => r.data as RewardData);

    async function twinFarmers(secret: string) {
      const a = await farmer();
      const b = await farmer();
      for (const { id } of [a, b]) {
        await database.db
          .update(activities)
          .set({ seedSecret: secret })
          .where(eq(activities.characterId, id));
      }
      return [a, b] as const;
    }

    it('settle vs filter change: every drop is granted or filtered once, by one rule set', async () => {
      const [racer, plain] = await twinFarmers('pg-filter-race');
      advance(2 * HOUR);
      const base = `/api/characters/${racer.id}`;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          i % 2 === 0
            ? call(racer.p, 'POST', `${base}/activity/settle`)
            : call(racer.p, 'POST', `${base}/loot-filter`, {
                rules: i % 4 === 1 ? filterRules : null,
              }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
      advance(HOUR);
      await call(racer.p, 'POST', `${base}/activity/settle`);
      await call(plain.p, 'POST', `/api/characters/${plain.id}/activity/settle`);

      const rewards = await rewardsOf(racer.id);
      expect(rewards.reduce((s, r) => s + r.creditedMs, 0)).toBe(3 * HOUR);
      // Each settlement used one rule set: its filtered drops all match the rules.
      for (const r of rewards) {
        for (const f of r.filtered?.items ?? []) {
          expect(['common', 'uncommon']).toContain(f.rarityId);
        }
      }
      // Same seeds as the unfiltered twin: kept ∪ filtered = its drops, nothing twice or lost.
      const kept = await database.db
        .select({ seed: itemInstances.seed })
        .from(itemInstances)
        .where(eq(itemInstances.characterId, racer.id));
      const filtered = rewards.flatMap((r) => r.filtered?.items ?? []).map((f) => f.seed);
      const twin = await database.db
        .select({ seed: itemInstances.seed })
        .from(itemInstances)
        .where(eq(itemInstances.characterId, plain.id));
      // The twin's pack can fill up: drops that don't fit are salvaged for gold and leave no
      // row, so compare drop counts in full and the seeds the twin kept (its earliest drops).
      const overflowOf = (rs: RewardData[]) => rs.reduce((s, r) => s + r.itemsSalvaged, 0);
      const twinRewards = await rewardsOf(plain.id);
      expect(kept.length + filtered.length + overflowOf(rewards)).toBe(
        twin.length + overflowOf(twinRewards),
      );
      const racerSeeds = new Set([...kept.map((k) => k.seed), ...filtered]);
      expect(new Set(racerSeeds).size).toBe(kept.length + filtered.length);
      if (overflowOf(rewards) === 0) {
        for (const t of twin) expect(racerSeeds.has(t.seed)).toBe(true);
      }
      if (overflowOf(twinRewards) === 0) {
        expect([...racerSeeds].sort()).toEqual(twin.map((t) => t.seed).sort());
      }
      expect(kept).toHaveLength(rewards.reduce((s, r) => s + r.items, 0));
      expect(await goldOf(racer.id)).toBe(rewards.reduce((s, r) => s + r.gold, 0));
    });

    it('sell and salvage vs lock: a locked item is never sold, a sold item never locked', async () => {
      const p = await newPlayer();
      const id = await newCharacter(p);
      const base = `/api/characters/${id}`;
      const outcomes = { lockWon: 0, taken: 0 };
      // At least six rounds, and more until both orders were seen (a slow runner can let the
      // later request win despite its head start, so the head start grows with the rounds).
      for (
        let round = 0;
        round < 6 || (round < 24 && !(outcomes.lockWon && outcomes.taken));
        round++
      ) {
        const target = await grant(id, 'barbute', 100 + round);
        const other = await grant(id, 'iron-helm', 200 + round);
        const [row] = await database.db
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.id, target));
        const before = await goldOf(id);
        // Which request reaches the character lock first depends on timing; every other round
        // the lock or the sales get a small head start, so both orders really happen.
        const headStart = 20 * (1 + Math.floor(round / 6));
        const lockDelay = round % 2 === 0 ? 0 : headStart;
        const sellDelay = round % 2 === 0 ? headStart : 0;
        const later = <T>(ms: number, f: () => Promise<T>) =>
          new Promise<T>((resolve, reject) => setTimeout(() => f().then(resolve, reject), ms));
        const results = await Promise.all([
          later(lockDelay, () => call(p, 'POST', `${base}/items/${target}/lock`)),
          later(sellDelay, () => keyed(p, `${base}/merchant/sell`, { itemIds: [other, target] })),
          later(sellDelay, () => keyed(p, `${base}/forge/salvage`, { itemIds: [target] })),
          later(lockDelay, () => call(p, 'POST', `${base}/items/${target}/lock`)),
        ]);
        for (const r of results) expect([200, 404, 409]).toContain(r.statusCode);
        const [left] = await database.db
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.id, target));
        const sells = (await eventsOf(id, 'merchant.sell')).filter((e) =>
          (e.data as { items: { itemId: string }[] }).items.some((i) => i.itemId === target),
        );
        const salvages = (await eventsOf(id, 'forge.salvage')).filter((e) =>
          JSON.stringify(e.data).includes(target),
        );
        if (left) {
          // The lock won: nothing took it, and the bulk sale (all or nothing) sold nothing.
          expect(left.locked).toBe(true);
          outcomes.lockWon++;
          expect(sells.length + salvages.length).toBe(0);
          expect(await goldOf(id)).toBe(before);
        } else {
          // A sale or salvage won; the lock found nothing (404).
          outcomes.taken++;
          expect(sells.length + salvages.length).toBe(1);
          const gained = sells.length ? sellPrice(row!) * 2 : salvageYield(row!).gold;
          expect(await goldOf(id)).toBe(before + gained);
        }
        // Clean up for the next round (the item the bulk sale may have left behind).
        await call(p, 'POST', `${base}/items/${target}/unlock`);
        await database.db.delete(itemInstances).where(eq(itemInstances.characterId, id));
      }
      // Both orders happened (the growing head starts make this certain in practice).
      expect(outcomes.lockWon).toBeGreaterThan(0);
      expect(outcomes.taken).toBeGreaterThan(0);
    });

    it('bulk sell vs settle with a filter: no item or gold lost or duplicated', async () => {
      const { p, id } = await farmer();
      const base = `/api/characters/${id}`;
      expect(
        (await call(p, 'POST', `${base}/loot-filter`, { rules: filterRules })).statusCode,
      ).toBe(200);
      const packed: string[] = [];
      for (let i = 0; i < 10; i++) packed.push(await grant(id, 'iron-helm', 300 + i));
      const prices = packed.length * sellPrice({ rarityId: 'common', itemLevel: 5 });
      advance(2 * HOUR);
      const results = await Promise.all([
        call(p, 'POST', `${base}/activity/settle`),
        keyed(p, `${base}/merchant/sell`, { itemIds: packed }),
        call(p, 'POST', `${base}/activity/settle`),
        keyed(p, `${base}/merchant/sell`, { itemIds: packed }),
        call(p, 'POST', `${base}/activity/settle`),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 404]);
      const rewards = await rewardsOf(id);
      expect(rewards.reduce((s, r) => s + r.creditedMs, 0)).toBe(2 * HOUR);
      expect(rewards.some((r) => (r.filtered?.items.length ?? 0) > 0)).toBe(true);
      const owned = await database.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, id));
      expect(owned.filter((i) => packed.includes(i.id))).toEqual([]);
      expect(owned).toHaveLength(rewards.reduce((s, r) => s + r.items, 0));
      expect(await eventsOf(id, 'merchant.sell')).toHaveLength(1);
      expect(await goldOf(id)).toBe(rewards.reduce((s, r) => s + r.gold, 0) + prices);
    });
  });

  describe('telemetry rollups (ticket 3.8)', () => {
    const rollups = async () => (await loadRollups(database.db, { from: null, to: null })).rows;
    async function expectReconciled() {
      const checks = await reconcileWithAudit(database.db);
      expect(checks.filter((c) => !c.ok)).toEqual([]);
    }

    it('settles, claims, sells and upgrades of many characters racing on the same counter rows reconcile with the audit log', async () => {
      // Every request below writes the same day's hot rows (gold.in, item.drop, …) at once.
      const farmers = await Promise.all(Array.from({ length: N }, () => farmer()));
      const crypt = await Promise.all(
        Array.from({ length: N }, async () => {
          const p = await newPlayer();
          const id = await newCharacter(p);
          await makeCryptReady(database.db, id, 'warrior', 16);
          const res = await call(p, 'POST', `/api/characters/${id}/dungeon`, {
            dungeonId: 'namelessCrypt',
          });
          expect(res.statusCode).toBe(201);
          return { p, id, endsAt: Date.parse(res.json<{ run: { endsAt: string } }>().run.endsAt) };
        }),
      );
      const sellers = await Promise.all(
        Array.from({ length: N }, async (_, n) => {
          const p = await newPlayer();
          const id = await newCharacter(p);
          const items = await Promise.all(
            [1, 2, 3].map((s) => grant(id, 'iron-helm', 900 + 10 * n + s)),
          );
          return { p, id, items };
        }),
      );
      const smiths = await Promise.all(
        Array.from({ length: N }, async (_, n) => {
          const p = await newPlayer();
          const id = await newCharacter(p);
          await setGold(id, 1_000_000);
          await database.db.insert(characterMaterials).values(
            (['timber', 'rawHide', 'ironOre', 'soulShard'] as const).map((materialId) => ({
              characterId: id,
              materialId,
              quantity: 10_000,
            })),
          );
          return { p, id, item: await grant(id, 'iron-helm', 950 + n) };
        }),
      );
      nowMs = Math.max(nowMs + 2 * HOUR, ...crypt.map((c) => c.endsAt));
      const before = await rollups();
      const claimKeys = crypt.map(() => randomUUID());
      const sellKeys = sellers.map(() => randomUUID());
      const results = await Promise.all([
        ...farmers.map(({ p, id }) => call(p, 'POST', `/api/characters/${id}/activity/settle`)),
        ...farmers.map(({ p, id }) => call(p, 'POST', `/api/characters/${id}/activity/settle`)),
        // Each claim and each sell twice with the same key: one runs, the twin replays.
        ...crypt.flatMap(({ p, id }, n) =>
          [0, 1].map(() => keyed(p, `/api/characters/${id}/dungeon/claim`, {}, claimKeys[n])),
        ),
        ...sellers.flatMap(({ p, id, items }, n) =>
          [0, 1].map(() =>
            keyed(p, `/api/characters/${id}/merchant/sell`, { itemIds: items }, sellKeys[n]),
          ),
        ),
        ...smiths.map(({ p, id, item }) =>
          keyed(p, `/api/characters/${id}/forge/upgrade`, { itemId: item }),
        ),
      ]);
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(results.filter((r) => r.headers['idempotency-replayed'] === 'true')).toHaveLength(
        2 * N,
      );

      const rows = await rollups();
      const delta = (
        metric: Parameters<typeof sumRollups>[1],
        match: Parameters<typeof sumRollups>[2] = () => true,
        field: 'events' | 'amount' = 'events',
      ) => sumRollups(rows, metric, match, field) - sumRollups(before, metric, match, field);
      expect(delta('farming.settle')).toBe(N);
      expect(delta('crypt.claim')).toBe(N);
      expect(delta('item.sold')).toBe(3 * N);
      expect(delta('gold.in', (d) => d[0] === 'merchant_sell', 'amount')).toBe(
        3 * N * sellPrice({ rarityId: 'common', itemLevel: 5 }),
      );
      expect(delta('forge', (d) => d[0] === 'upgrade')).toBe(N);
      await expectReconciled();
    });

    it('every race in this file left rollups exactly consistent with the audit log', async () => {
      await expectReconciled();
    });
  });

  it('the races above ran without a single deadlock or serialization retry', () => {
    expect(transactionStats.retries).toBe(0);
  });
});
