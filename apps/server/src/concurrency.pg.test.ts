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
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { generateItem } from '@worldforge/game-core';
import { buildApp } from './app.js';
import { SESSION_COOKIE } from './auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from './activity/settle.js';
import {
  accounts,
  activities,
  auditLog,
  characterMaterials,
  characterProfessions,
  characters,
  dungeonRuns,
  itemInstances,
} from './db/schema.js';
import { transactionStats, withTransaction } from './db/transaction.js';
import type { DatabaseHandle } from './db/types.js';
import { uuidv7 } from './db/uuid.js';
import { createPostgresTestDatabase } from './test/db.js';
import { makeCryptReady } from './test/dungeon.js';

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
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26);
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
        withTransaction(database.db, (tx) => tx.execute(sql`select pg_sleep(0.3)`)),
      ),
    );
    // Serial execution would take ≥ 1.2 s.
    expect(Date.now() - t0).toBeLessThan(1_000);
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
            eq(itemInstances.source, 'dungeon:namelessCrypt'),
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

  // Runs last (tests in a file run in order). Retries keep the races correct, but each one is a
  // deadlock: before ticket 1.9 used `FOR NO KEY UPDATE` for the account/character locks, the
  // foreign-key checks of audit and activity inserts (`FOR KEY SHARE`) deadlocked against them
  // (start: account → character; stop/settle: character → account), about 4 per run.
  it('the races above ran without a single deadlock or serialization retry', () => {
    expect(transactionStats.retries).toBe(0);
  });
});
