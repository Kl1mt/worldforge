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
import { randomUUID } from 'node:crypto';
import { generateItem, salvageYield, sellPrice } from '@worldforge/game-core';
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
import { recordQuestEventsTx } from './quests/store.js';

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
      expect(results.slice(3).map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);

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
  });

  it('the races above ran without a single deadlock or serialization retry', () => {
    expect(transactionStats.retries).toBe(0);
  });
});
