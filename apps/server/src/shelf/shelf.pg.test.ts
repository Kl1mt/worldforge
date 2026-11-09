/**
 * Real-PostgreSQL races for the account shelf (ticket T.3, docs/TRADING.md "Test strategy",
 * docs/WAREHOUSE.md "Account shelf"). Runs when `DATABASE_URL` is set, skipped otherwise (CI sets
 * `REQUIRE_PG_TESTS=1`). Every shelf move takes the account's shelf lock, then the hero (settling
 * first), its items and the shelf's rows. Each race runs a few rounds in varied orders and asserts
 * only what holds in every order: nothing is created or lost, every holding equals the audit
 * replay, an item is in exactly one place, a key moves once, and nothing is retried.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { accounts, auditLog, characterMaterials, characters, itemInstances } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { fund } from '../test/community.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { openWarehouse } from '../test/warehouse.js';
import { ALL_SHELF_ON, setShelfSwitches, type ShelfBody } from '../test/shelf.js';
import { expectShelfMatchesAudit } from '../e2e/journey.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const HOUR = 3_600_000;

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 11 + round * 37;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.skipIf(!url)('real PostgreSQL: the account shelf races safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2031-07-01T10:00:00Z');

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
    app = buildApp({
      database,
      auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
    });
    await app.ready();
    await openWarehouse(app, database.db);
    await setShelfSwitches(app, database.db, ALL_SHELF_ON);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const send = (
    who: TestAccount,
    method: 'POST' | 'DELETE',
    path: string,
    payload?: object,
    key: string | null = null,
  ) =>
    app.inject({
      method,
      url: path,
      ...(payload ? { payload } : {}),
      headers: key ? { 'idempotency-key': key } : {},
      cookies: { [SESSION_COOKIE]: who.token },
    });
  const shelf = (
    who: TestAccount,
    hero: string,
    direction: 'deposit' | 'withdraw',
    body: ShelfBody,
    key: string = randomUUID(),
  ) => send(who, 'POST', `/api/characters/${hero}/shelf/${direction}`, body, key);
  const label = (name: string, r: { statusCode: number; json: () => unknown }) =>
    `${name} ${r.statusCode} ${r.statusCode === 200 ? '' : (r.json() as { error: { code: string } }).error.code}`;

  async function account() {
    const who = await insertAccount(db());
    const a = await insertCharacter(db(), who.id, { level: 10 });
    const b = await insertCharacter(db(), who.id, { level: 10 });
    await db().update(accounts).set({ activeCharacterId: a.id }).where(eq(accounts.id, who.id));
    return { who, a: a.id, b: b.id };
  }
  const goldOf = async (id: string) =>
    (await db().select().from(characters).where(eq(characters.id, id)))[0]!.gold;
  const shelfGoldOf = async (id: string) =>
    (await db().select().from(accounts).where(eq(accounts.id, id)))[0]!.shelfGold;
  const timberOf = async (characterId: string) =>
    (
      await db()
        .select()
        .from(characterMaterials)
        .where(
          and(
            eq(characterMaterials.characterId, characterId),
            eq(characterMaterials.materialId, 'timber'),
          ),
        )
    )[0]?.quantity ?? 0;
  const shelfAudits = (accountId: string) =>
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), like(auditLog.event, 'shelf.%')))
      .orderBy(auditLog.id);

  it('both heroes depositing and withdrawing at once: nothing created or lost', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await account();
      await fund(db(), acc.a, { gold: 1_000, materials: { timber: 100 } });
      await fund(db(), acc.b, { gold: 1_000, materials: { timber: 100 } });
      const itemsA = await Promise.all([1, 2, 3].map(() => insertItem(db(), acc.a)));
      const itemsB = await Promise.all([1, 2, 3].map(() => insertItem(db(), acc.b)));
      // Something on the shelf already, so withdrawals can win too.
      const seed = await shelf(acc.who, acc.a, 'deposit', {
        itemIds: [itemsA[0]!.id],
        gold: 300,
        materials: { timber: 30 },
      });
      expect(seed.statusCode, seed.body).toBe(200);
      nowMs += HOUR;
      const ops = shuffled<[string, () => ReturnType<typeof shelf>]>(
        [
          [
            'dep A',
            () => shelf(acc.who, acc.a, 'deposit', { gold: 200, materials: { timber: 20 } }),
          ],
          [
            'dep B',
            () => shelf(acc.who, acc.b, 'deposit', { gold: 250, materials: { timber: 25 } }),
          ],
          [
            'dep A item',
            () => shelf(acc.who, acc.a, 'deposit', { itemIds: [itemsA[1]!.id, itemsA[2]!.id] }),
          ],
          [
            'dep B item',
            () => shelf(acc.who, acc.b, 'deposit', { itemIds: itemsB.map((i) => i.id) }),
          ],
          [
            'wd A',
            () => shelf(acc.who, acc.a, 'withdraw', { gold: 400, materials: { timber: 40 } }),
          ],
          [
            'wd B',
            () => shelf(acc.who, acc.b, 'withdraw', { gold: 400, materials: { timber: 40 } }),
          ],
          ['wd B item', () => shelf(acc.who, acc.b, 'withdraw', { itemIds: [itemsA[0]!.id] })],
          ['wd A item', () => shelf(acc.who, acc.a, 'withdraw', { itemIds: [itemsA[0]!.id] })],
        ],
        round,
      );
      const results = await Promise.all(ops.map(([, op]) => op()));
      for (const [i, [name]] of ops.entries()) {
        expect(
          [
            `${name} 200 `,
            // A withdrawal can find the shelf short (another withdrawal won).
            `${name} 422 insufficient_gold`,
            `${name} 422 insufficient_materials`,
            // The item went to the other hero first.
            `${name} 404 not_found`,
          ],
          `round ${round}`,
        ).toContain(label(name, results[i]!));
      }
      // Deposits never fail here (enough on each hero, room on the shelf).
      for (const [i, [name]] of ops.entries()) {
        if (name.startsWith('dep')) expect(results[i]!.statusCode, name).toBe(200);
      }
      // Exactly one hero took the item.
      const itemWins = ops.filter(
        ([n], i) => n.endsWith('item') && n.startsWith('wd') && results[i]!.statusCode === 200,
      );
      expect(itemWins).toHaveLength(1);
      // Gold and timber are conserved across the account (two heroes + the shelf).
      const gold = (await goldOf(acc.a)) + (await goldOf(acc.b)) + (await shelfGoldOf(acc.who.id));
      expect(gold, `round ${round}`).toBe(2_000);
      const [row] = await db().select().from(accounts).where(eq(accounts.id, acc.who.id));
      expect(row!.shelfGold).toBeGreaterThanOrEqual(0);
      const replay = await expectShelfMatchesAudit(database, acc.who.id);
      expect(
        (await timberOf(acc.a)) + (await timberOf(acc.b)) + (replay.materials.timber ?? 0),
      ).toBe(200);
      // Items: 6 in all, each in exactly one place.
      const rows = await db()
        .select()
        .from(itemInstances)
        .where(and(eq(itemInstances.onShelf, true), eq(itemInstances.shelfAccountId, acc.who.id)));
      expect(rows).toHaveLength(replay.items);
      expect(replay.items).toBe(5);
    }
    expect((await reconcileWithAudit(db())).filter((x) => !x.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('a double submit with the same key moves once and replays the same answer', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await account();
      await fund(db(), acc.a, { gold: 1_000, materials: { timber: 10 } });
      const item = await insertItem(db(), acc.a);
      const key = randomUUID();
      const body = { itemIds: [item.id], gold: 600, materials: { timber: 10 } };
      const results = await Promise.all(
        Array.from({ length: 4 }, () => shelf(acc.who, acc.a, 'deposit', body, key)),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(200);
      const replayed = results.filter((r) => r.headers['idempotency-replayed'] === 'true');
      expect(replayed).toHaveLength(3);
      for (const r of results) expect(r.json()).toEqual(results[0]!.json());
      expect(await goldOf(acc.a)).toBe(400);
      expect(await shelfGoldOf(acc.who.id)).toBe(600);
      expect(await shelfAudits(acc.who.id)).toHaveLength(3);
      // The same for a withdrawal by the other hero.
      const wkey = randomUUID();
      const outs = await Promise.all(
        Array.from({ length: 4 }, () => shelf(acc.who, acc.b, 'withdraw', body, wkey)),
      );
      for (const r of outs) expect(r.statusCode, r.body).toBe(200);
      expect(await goldOf(acc.b)).toBe(600);
      expect(await shelfGoldOf(acc.who.id)).toBe(0);
      await expectShelfMatchesAudit(database, acc.who.id);
    }
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('deposit and withdrawals of one item racing a sell and a forge: one place, taken at most once', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS * 2; round++) {
      const acc = await account();
      await fund(db(), acc.a, { gold: 100_000, materials: { timber: 1_000, rawHide: 1_000 } });
      const item = await insertItem(db(), acc.a, { baseId: 'longsword' });
      const a = `/api/characters/${acc.a}`;
      const ops = shuffled<[string, () => ReturnType<typeof shelf>]>(
        [
          ['deposit', () => shelf(acc.who, acc.a, 'deposit', { itemIds: [item.id] })],
          ['withdraw B', () => shelf(acc.who, acc.b, 'withdraw', { itemIds: [item.id] })],
          ['withdraw A', () => shelf(acc.who, acc.a, 'withdraw', { itemIds: [item.id] })],
          [
            'sell',
            () => send(acc.who, 'POST', `${a}/merchant/sell`, { itemIds: [item.id] }, randomUUID()),
          ],
          [
            'forge',
            () => send(acc.who, 'POST', `${a}/forge/upgrade`, { itemId: item.id }, randomUUID()),
          ],
        ],
        round,
      );
      const results = await Promise.all(ops.map(([, op]) => op()));
      for (const [i, [name]] of ops.entries()) {
        const l = label(name, results[i]!);
        expect(
          [
            'deposit 200 ',
            'withdraw B 200 ',
            'withdraw A 200 ',
            'sell 200 ',
            'forge 200 ',
            // On the shelf: nothing else touches it.
            'sell 409 item_on_shelf',
            'forge 409 item_on_shelf',
            'deposit 409 item_on_shelf',
            // Not on the shelf (yet, or any more), or gone, or moved to the other hero.
            'withdraw B 404 not_found',
            'withdraw A 404 not_found',
            'deposit 404 not_found',
            'sell 404 not_found',
            'forge 404 not_found',
          ],
          `round ${round}`,
        ).toContain(l);
      }
      const sold = results.some((r, i) => ops[i]![0] === 'sell' && r.statusCode === 200);
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, item.id));
      // One deposit request, so at most one deposit and one withdrawal are audited (moves of
      // one item alternate); where they leave it is order-free.
      const audits = await shelfAudits(acc.who.id);
      const deposits = audits.filter((a) => a.event === 'shelf.deposit');
      const withdrawals = audits.filter((a) => a.event === 'shelf.withdraw');
      expect(deposits.length).toBeLessThanOrEqual(1);
      expect(withdrawals.length).toBeLessThanOrEqual(deposits.length);
      const holder = withdrawals[0]?.characterId ?? acc.a;
      if (sold) {
        expect(row).toBeUndefined();
        // Sold from A's pack: nothing on the shelf, and A held it.
        expect(withdrawals.length).toBe(deposits.length);
        expect(holder).toBe(acc.a);
      } else if (deposits.length > withdrawals.length) {
        expect(row).toMatchObject({
          onShelf: true,
          shelfAccountId: acc.who.id,
          characterId: acc.a,
        });
      } else {
        expect(row).toMatchObject({ onShelf: false, shelfAccountId: null, characterId: holder });
      }
      await expectShelfMatchesAudit(database, acc.who.id);
      // A forge 200 bound the item (T.1) and drew once; the shelf never did.
      const forged = results.some((r, i) => ops[i]![0] === 'forge' && r.statusCode === 200);
      if (row) expect(row.forgeCounter).toBe(forged ? 1 : 0);
    }
    expect((await reconcileWithAudit(db())).filter((x) => !x.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('withdraw vs deposit of the same item: both orders, one place each time', async () => {
    const retries = transactionStats.retries;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const seen = { depositFirst: 0, withdrawFirst: 0 };
    // Keep going until both orders were seen, with a growing head start, within a bound.
    for (let round = 0; round < 40; round++) {
      if (seen.depositFirst > 0 && seen.withdrawFirst > 0 && round >= ROUNDS) break;
      const acc = await account();
      const item = await insertItem(db(), acc.a);
      const lead = Math.floor(round / 2) * 5;
      const depositLeads = round % 2 === 0;
      const deposit = (async () => {
        if (!depositLeads) await sleep(lead);
        return shelf(acc.who, acc.a, 'deposit', { itemIds: [item.id] });
      })();
      const withdrawals = [acc.b, acc.a].map(async (hero) => {
        if (depositLeads) await sleep(lead);
        return shelf(acc.who, hero, 'withdraw', { itemIds: [item.id] });
      });
      const [dep, ...outs] = await Promise.all([deposit, ...withdrawals]);
      // The deposit always succeeds: nothing else can take the item from A's pack here.
      expect(dep!.statusCode, dep!.body).toBe(200);
      const won = outs.filter((r) => r.statusCode === 200);
      for (const r of outs) expect([200, 404]).toContain(r.statusCode);
      expect(won.length).toBeLessThanOrEqual(1);
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, item.id));
      const audits = await shelfAudits(acc.who.id);
      if (won.length === 1) {
        seen.depositFirst += 1;
        const taker = audits.find((a) => a.event === 'shelf.withdraw')!.characterId;
        expect(row).toMatchObject({ onShelf: false, shelfAccountId: null, characterId: taker });
      } else {
        seen.withdrawFirst += 1;
        expect(row).toMatchObject({
          onShelf: true,
          shelfAccountId: acc.who.id,
          characterId: acc.a,
        });
      }
      await expectShelfMatchesAudit(database, acc.who.id);
    }
    expect(seen.depositFirst, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.withdrawFirst, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('a shelved item racing a withdrawal, sells, salvage, forge work and a deposit: never taken', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await account();
      await fund(db(), acc.a, { gold: 100_000, materials: { timber: 1_000, rawHide: 1_000 } });
      const item = await insertItem(db(), acc.a, { baseId: 'longsword' });
      expect((await shelf(acc.who, acc.a, 'deposit', { itemIds: [item.id] })).statusCode).toBe(200);
      const before = (
        await db().select().from(itemInstances).where(eq(itemInstances.id, item.id))
      )[0]!;
      nowMs += HOUR;
      const a = `/api/characters/${acc.a}`;
      const k = () => randomUUID();
      const ops = shuffled<[string, () => ReturnType<typeof shelf>]>(
        [
          ['withdraw', () => shelf(acc.who, acc.b, 'withdraw', { itemIds: [item.id] })],
          ['sell', () => send(acc.who, 'POST', `${a}/merchant/sell`, { itemIds: [item.id] }, k())],
          [
            'salvage',
            () => send(acc.who, 'POST', `${a}/forge/salvage`, { itemIds: [item.id] }, k()),
          ],
          ['discard', () => send(acc.who, 'DELETE', `${a}/items/${item.id}`)],
          ['forge', () => send(acc.who, 'POST', `${a}/forge/upgrade`, { itemId: item.id }, k())],
          ['deposit', () => shelf(acc.who, acc.a, 'deposit', { itemIds: [item.id] })],
        ],
        round,
      );
      const results = await Promise.all(ops.map(([, op]) => op()));
      for (const [i, [name]] of ops.entries()) {
        const l = label(name, results[i]!);
        if (name === 'withdraw') expect(l).toBe('withdraw 200 ');
        // Before the withdrawal: on the shelf. After: B's item, not A's.
        else expect([`${name} 409 item_on_shelf`, `${name} 404 not_found`], l).toContain(l);
      }
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, item.id));
      expect(row).toEqual({ ...before, onShelf: false, shelfAccountId: null, characterId: acc.b });
      expect(await goldOf(acc.a)).toBe(100_000);
      await expectShelfMatchesAudit(database, acc.who.id);
    }
    expect((await reconcileWithAudit(db())).filter((x) => !x.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });
});
