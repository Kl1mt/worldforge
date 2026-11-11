import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { MATERIAL_IDS, generateItem, settleFarming, type RarityId } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  activities,
  auditLog,
  characterMaterials,
  characterQuests,
  characters,
  itemInstances,
  telemetryDaily,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import type { MerchantResponse } from '../merchant/routes.js';
import type { QuestBoardResponse } from '../quests/store.js';
import { pendingTelemetry, recordTelemetry, telemetryDay } from './record.js';
import {
  buildSignature,
  buildTelemetryReport,
  loadRollups,
  reconcileWithAudit,
  renderTelemetryReport,
  sumRollups,
  type RollupRow,
} from './report.js';
import { safeLetters } from '../test/names.js';

const HOUR = 60 * 60 * 1000;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-04T12:00:00Z');
const advance = (ms: number) => (nowMs += ms);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface Player {
  token: string;
  accountId: string;
  id: string;
  email: string;
  name: string;
}

let seq = 0;
// Ticket 6.9: letters that never look alike (two generated names are never refused as look-alikes).
const letters = (n: number) => safeLetters(n);
const players: Player[] = [];

async function newPlayer({ gold = 50_000, classId = 'warrior' } = {}): Promise<Player> {
  seq += 1;
  const email = `ledger${seq}@graumark.test`;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, displayName: `Ledger ${seq}`, password: 'ashes-and-iron-42' },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const name = `Tallyman${letters(seq)}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name, classId, appearance: { banner: 'ash' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  const id = created.json<{ character: { id: string } }>().character.id;
  await database.db.update(characters).set({ gold }).where(eq(characters.id, id));
  await database.db
    .insert(characterMaterials)
    .values(MATERIAL_IDS.map((materialId) => ({ characterId: id, materialId, quantity: 1_000 })));
  const p = {
    token,
    accountId: reg.json<{ account: { id: string } }>().account.id,
    id,
    email,
    name,
  };
  players.push(p);
  return p;
}

function call(
  p: Player,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: object,
  key: string | null = randomUUID(),
) {
  return app.inject({
    method,
    url: `/api/characters/${p.id}${path}`,
    ...(payload ? { payload } : {}),
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { [SESSION_COOKIE]: p.token },
  });
}

async function grant(
  p: Player,
  { baseId = 'barbute', rarityId = 'rare' as RarityId, itemLevel = 14, seed = 5 } = {},
) {
  const item = generateItem({ seed, itemLevel, baseId, rarityId, classId: 'warrior' })!;
  const id = uuidv7();
  await database.db
    .insert(itemInstances)
    .values({ id, characterId: p.id, ...item, source: 'test' });
  return id;
}

const rollups = async () => (await loadRollups(database.db, { from: null, to: null })).rows;
const total = (
  rows: RollupRow[],
  metric: RollupRow['metric'],
  match: (d: RollupRow['dims']) => boolean = () => true,
  field: 'events' | 'amount' = 'events',
) => sumRollups(rows, metric, match, field);

async function expectReconciled() {
  const checks = await reconcileWithAudit(database.db);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
  return checks;
}

async function auditsOf(p: Player, event: string) {
  return database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, p.id), eq(auditLog.event, event)));
}

describe('empty state', () => {
  it('reports no telemetry before anything happened', async () => {
    const report = await buildTelemetryReport(
      database.db,
      { from: null, to: null },
      { reconcile: true },
    );
    expect(report.rollups).toEqual([]);
    expect(report.window.days).toBe(0);
    const text = renderTelemetryReport(report);
    expect(text).toContain('No telemetry recorded in this window.');
    expect(text).toContain('Nobody has anything equipped yet.');
    expect(text).toMatch(/all \d+ checks match/);
  });
});

describe('recorder', () => {
  it('refuses dimensions that are not content ids (ids, emails, free text)', async () => {
    await withTransaction(database.db, async (tx) => {
      const now = new Date(nowMs);
      expect(() => recordTelemetry(tx, now, [{ metric: 'gold.in', dims: [uuidv7()] }])).toThrow(
        /content id/,
      );
      expect(() => recordTelemetry(tx, now, [{ metric: 'gold.in', dims: ['a@b.test'] }])).toThrow(
        /content id/,
      );
      expect(() =>
        recordTelemetry(tx, now, [{ metric: 'gold.in', dims: ['Hagen the Bold'] }]),
      ).toThrow(/content id/);
      expect(() => recordTelemetry(tx, now, [{ metric: 'gold.in', amount: 1.5 }])).toThrow(
        /integers/,
      );
      // Nothing valid was recorded, so nothing is written.
      expect(pendingTelemetry(tx)).toEqual([]);
    });
    expect(await rollups()).toEqual([]);
  });

  it('sums per transaction, flushes in key order, and writes nothing on rollback', async () => {
    const now = new Date(nowMs);
    await withTransaction(database.db, async (tx) => {
      recordTelemetry(tx, now, [{ metric: 'gold.in', dims: ['zz_test'], amount: 3 }]);
      recordTelemetry(tx, now, [
        { metric: 'gold.in', dims: ['aa_test'], amount: 1 },
        { metric: 'gold.in', dims: ['zz_test'], amount: 4 },
      ]);
      expect(pendingTelemetry(tx).map((r) => [r.dim1, r.events, r.amount])).toEqual([
        ['aa_test', 1, 1],
        ['zz_test', 2, 7],
      ]);
    });
    await expect(
      withTransaction(database.db, async (tx) => {
        recordTelemetry(tx, now, [{ metric: 'gold.in', dims: ['zz_test'], amount: 100 }]);
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    const rows = await rollups();
    expect(rows.map((r) => [r.dims[0], r.events, r.amount])).toEqual([
      ['aa_test', 1, 1],
      ['zz_test', 2, 7],
    ]);
    expect(telemetryDay(now)).toBe('2026-11-04');
    // Clean up the synthetic rows, so the reconciliation below sees only real traffic.
    await database.db.delete(telemetryDaily);
  });
});

describe('value paths', () => {
  it('farming settlement: one settle, drops by rarity, gold, XP and gathering', async () => {
    const p = await newPlayer();
    expect((await call(p, 'POST', '/activity', { areaId: 'abandonedFields' })).statusCode).toBe(
      201,
    );
    advance(2 * HOUR);
    expect((await call(p, 'POST', '/activity/settle')).statusCode).toBe(200);
    const rows = await rollups();
    const [audit] = await auditsOf(p, 'activity.reward');
    const data = audit!.data as { items: number; itemsSalvaged: number; gold: number; xp: number };
    expect(total(rows, 'farming.settle')).toBe(1);
    // Simulated seconds: whole fight cycles, at most the credited two hours.
    expect(total(rows, 'farming.settle', () => true, 'amount')).toBeGreaterThan(3600);
    expect(total(rows, 'farming.settle', () => true, 'amount')).toBeLessThanOrEqual(2 * 3600);
    expect(total(rows, 'item.drop', (d) => d[0] === 'farming' && d[1] === 'abandonedFields')).toBe(
      data.items + data.itemsSalvaged,
    );
    expect(data.items).toBeGreaterThan(0);
    expect(total(rows, 'xp.in', (d) => d[0] === 'farming', 'amount')).toBe(data.xp);
    await expectReconciled();
  });

  it('a full pack: overflow counts and the auto-salvage gold', async () => {
    const p = await newPlayer();
    await database.db.insert(itemInstances).values(
      Array.from({ length: 60 }, (_, n) => ({
        id: uuidv7(),
        characterId: p.id,
        ...generateItem({ seed: n, itemLevel: 3, baseId: 'iron-helm', rarityId: 'common' })!,
        source: 'test',
      })),
    );
    const before = await rollups();
    await call(p, 'POST', '/activity', { areaId: 'abandonedFields' });
    advance(HOUR);
    await call(p, 'POST', '/activity/settle');
    const rows = await rollups();
    const [audit] = await auditsOf(p, 'activity.reward');
    const data = audit!.data as { items: number; itemsSalvaged: number; goldSalvaged: number };
    // Ticket B.2: only a valuable drop (Legendary and up) may still reach a full pack.
    expect(data.items).toBe((data as { itemsOverCapacity?: number }).itemsOverCapacity ?? 0);
    expect(data.itemsSalvaged).toBeGreaterThan(0);
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(delta('pack.overflow', (d) => d[0] === 'farming')).toBe(1);
    expect(delta('pack.overflow', (d) => d[0] === 'farming', 'amount')).toBe(data.itemsSalvaged);
    expect(delta('item.fate', (d) => d[0] === 'farming' && d[1] === 'overflow_salvaged')).toBe(
      data.itemsSalvaged,
    );
    expect(delta('gold.in', (d) => d[0] === 'farming_overflow', 'amount')).toBe(data.goldSalvaged);
    await expectReconciled();
  });

  it('a full pack keeps valuable drops over capacity (ticket B.2)', async () => {
    const p = await newPlayer();
    const cap = DEFAULT_ACTIVITY_OPTIONS.rules.inventory.capacity;
    await database.db.insert(itemInstances).values(
      Array.from({ length: cap }, (_, n) => ({
        id: uuidv7(),
        characterId: p.id,
        ...generateItem({ seed: n, itemLevel: 3, baseId: 'iron-helm', rarityId: 'common' })!,
        source: 'test',
      })),
    );
    // A seed whose first hour drops a Legendary or better (searched with the same rules).
    const seed = Array.from({ length: 200 }, (_, n) => `over-capacity:${n}`).find(
      (s) =>
        settleFarming({
          character: { classId: 'warrior', level: 1, xp: 0 },
          areaId: 'abandonedFields',
          seed: s,
          firstCycle: 0,
          durationMs: HOUR,
          inventoryCount: cap,
        }).overCapacity.length > 0,
    )!;
    const before = await rollups();
    await call(p, 'POST', '/activity', { areaId: 'abandonedFields' });
    await database.db
      .update(activities)
      .set({ seedSecret: seed })
      .where(eq(activities.characterId, p.id));
    advance(HOUR);
    const settled = await call(p, 'POST', '/activity/settle');
    const summary = settled.json().summary as { itemsOverCapacity?: number; itemsGained: number };
    const rows = await rollups();
    const [audit] = await auditsOf(p, 'activity.reward');
    const data = audit!.data as { items: number; itemsSalvaged: number; itemsOverCapacity: number };
    expect(data.itemsOverCapacity).toBeGreaterThan(0);
    expect(data.items).toBe(data.itemsOverCapacity);
    expect(summary.itemsOverCapacity).toBe(data.itemsOverCapacity);
    expect(summary.itemsGained).toBe(data.items);
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(delta('pack.over_capacity', (d) => d[0] === 'farming')).toBe(1);
    expect(delta('pack.over_capacity', (d) => d[0] === 'farming', 'amount')).toBe(
      data.itemsOverCapacity,
    );
    expect(delta('item.fate', (d) => d[0] === 'farming' && d[1] === 'kept_over_capacity')).toBe(
      data.itemsOverCapacity,
    );
    expect(delta('item.fate', (d) => d[0] === 'farming' && d[1] === 'kept')).toBe(0);
    // The pack is over capacity now, and holds every one of them.
    const held = await database.db
      .select({ rarityId: itemInstances.rarityId })
      .from(itemInstances)
      .where(eq(itemInstances.characterId, p.id));
    expect(held.length).toBe(cap + data.itemsOverCapacity);
    await expectReconciled();
  });

  it('the loot filter: filtered drops and their yield, apart from manual sells and salvages', async () => {
    const p = await newPlayer();
    const rules = {
      action: 'sell',
      belowRarity: 'rare',
      wantedAffixes: [],
      wantedEffects: [],
      include: [],
    };
    expect((await call(p, 'POST', '/loot-filter', { rules })).statusCode).toBe(200);
    const before = await rollups();
    await call(p, 'POST', '/activity', { areaId: 'abandonedFields' });
    advance(2 * HOUR);
    await call(p, 'POST', '/activity/settle');
    const rows = await rollups();
    const [audit] = await auditsOf(p, 'activity.reward');
    const filtered = (audit!.data as { filtered: { sold: number; gold: number } }).filtered;
    expect(filtered.sold).toBeGreaterThan(0);
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean = () => true,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(delta('item.fate', (d) => d[1] === 'filter_sold')).toBe(filtered.sold);
    expect(delta('item.fate', (d) => d[1] === 'filter_sold', 'amount')).toBe(filtered.gold);
    expect(delta('gold.in', (d) => d[0] === 'farming_filter', 'amount')).toBe(filtered.gold);
    // Filtered drops are still drops (the drop rate counts every rolled item)…
    expect(delta('item.drop')).toBeGreaterThanOrEqual(filtered.sold);
    // …but not manual sells or salvages.
    expect(delta('item.sold')).toBe(0);
    expect(delta('gold.in', (d) => d[0] === 'merchant_sell', 'amount')).toBe(0);
    await expectReconciled();
  });

  it('merchant buy and sell count once, even when the Idempotency-Key is replayed', async () => {
    const p = await newPlayer();
    const before = await rollups();
    const stock = (await call(p, 'GET', '/merchant')).json<MerchantResponse>();
    const offer = stock.offers[0]!;
    const buyKey = randomUUID();
    const bought = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId }, buyKey);
    expect(bought.statusCode).toBe(200);
    const replay = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId }, buyKey);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    // A refused request records nothing either.
    expect((await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId })).statusCode).toBe(
      409,
    );

    const a = await grant(p, { rarityId: 'rare' });
    const b = await grant(p, { rarityId: 'common', baseId: 'iron-helm', itemLevel: 3 });
    const sellKey = randomUUID();
    const sold = await call(p, 'POST', '/merchant/sell', { itemIds: [a, b] }, sellKey);
    expect(sold.statusCode).toBe(200);
    await call(p, 'POST', '/merchant/sell', { itemIds: [a, b] }, sellKey);
    const goldGained = sold.json<{ goldGained: number }>().goldGained;

    const rows = await rollups();
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean = () => true,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(delta('item.drop', (d) => d[0] === 'merchant')).toBe(1);
    expect(delta('gold.out', (d) => d[0] === 'merchant_buy', 'amount')).toBe(offer.price);
    expect(delta('item.sold')).toBe(2);
    expect(delta('item.sold', (d) => d[0] === 'rare')).toBe(1);
    expect(delta('gold.in', (d) => d[0] === 'merchant_sell', 'amount')).toBe(goldGained);
    await expectReconciled();
  });

  it('forge: salvage, craft, upgrade (replayed), reroll and improve', async () => {
    const p = await newPlayer({ gold: 1_000_000 });
    const before = await rollups();
    const junk = await grant(p, { rarityId: 'uncommon', baseId: 'iron-helm', itemLevel: 5 });
    expect((await call(p, 'POST', '/forge/salvage', { itemIds: [junk] })).statusCode).toBe(200);
    const crafted = await call(p, 'POST', '/forge/craft', {
      recipeId: 'fieldsmithWork',
      slot: 'weapon',
    });
    expect(crafted.statusCode).toBe(200);

    const item = await grant(p, { rarityId: 'rare' });
    const key = randomUUID();
    const up = await call(p, 'POST', '/forge/upgrade', { itemId: item }, key);
    expect(up.statusCode).toBe(200);
    expect(
      (await call(p, 'POST', '/forge/upgrade', { itemId: item }, key)).headers[
        'idempotency-replayed'
      ],
    ).toBe('true');
    for (let n = 0; n < 4; n++) {
      expect((await call(p, 'POST', '/forge/upgrade', { itemId: item })).statusCode).toBe(200);
    }
    expect(
      (await call(p, 'POST', '/forge/reroll', { itemId: item, affixIndex: 0 })).statusCode,
    ).toBe(200);
    expect(
      (await call(p, 'POST', '/forge/improve', { itemId: item, affixIndex: 1 })).statusCode,
    ).toBe(200);

    const rows = await rollups();
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean = () => true,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(delta('forge', (d) => d[0] === 'salvage')).toBe(1);
    expect(delta('forge', (d) => d[0] === 'craft' && d[1] === 'fieldsmithWork')).toBe(1);
    expect(delta('item.drop', (d) => d[0] === 'craft')).toBe(1);
    expect(delta('forge', (d) => d[0] === 'upgrade')).toBe(5);
    // The first upgrade (+1) is certain; successes and failures add up to the tries.
    expect(delta('forge', (d) => d[0] === 'upgrade' && d[1] === '+1' && d[2] !== 'failure')).toBe(
      1,
    );
    expect(delta('forge', (d) => d[0] === 'reroll' && d[1] === 'rare')).toBe(1);
    expect(delta('forge', (d) => d[0] === 'improve')).toBe(1);
    const spent = (
      await database.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.characterId, p.id),
            sql`${auditLog.event} like 'forge.%' and ${auditLog.event} <> 'forge.salvage'`,
          ),
        )
    ).reduce((s, a) => s + Number((a.data as { gold: number }).gold), 0);
    expect(delta('gold.out', (d) => d[0].startsWith('forge_'), 'amount')).toBe(spent);
    expect(delta('material.out', (d) => d[0].startsWith('forge_'), 'amount')).toBeGreaterThan(0);
    await expectReconciled();
  });

  it('item discard', async () => {
    const p = await newPlayer();
    const before = await rollups();
    const item = await grant(p, { rarityId: 'epic' });
    expect((await call(p, 'DELETE', `/items/${item}`, undefined, null)).statusCode).toBe(200);
    const rows = await rollups();
    expect(
      total(rows, 'item.discarded', (d) => d[0] === 'epic') -
        total(before, 'item.discarded', (d) => d[0] === 'epic'),
    ).toBe(1);
    await expectReconciled();
  });
});

describe('crypt', () => {
  it('counts a won claim, splits the boss hoard from chamber drops, and a replay adds nothing', async () => {
    const p = await newPlayer();
    await makeCryptReady(database.db, p.id, 'warrior', 16);
    const before = await rollups();
    const entered = await call(p, 'POST', '/dungeon', { dungeonId: 'namelessCrypt' }, null);
    expect(entered.statusCode).toBe(201);
    nowMs = Date.parse(entered.json<{ run: { endsAt: string } }>().run.endsAt);
    const key = randomUUID();
    const claimed = await call(p, 'POST', '/dungeon/claim', undefined, key);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ result: { bossLoot: boolean; outcome: string } }>().result).toMatchObject(
      {
        bossLoot: true,
        outcome: 'cleared',
      },
    );
    await call(p, 'POST', '/dungeon/claim', undefined, key);

    const rows = await rollups();
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean = () => true,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(
      delta('crypt.start', (d) => d[0] === 'namelessCrypt:1' && d[1] === 'hoard_eligible'),
    ).toBe(1);
    expect(
      delta('crypt.claim', (d) => d[0] === 'namelessCrypt:1' && d[1] === 'won' && d[2] === 'hoard'),
    ).toBe(1);
    // The Gravewarden's hoard is two items (docs/DUNGEONS.md), never a common.
    expect(delta('item.drop', (d) => d[0] === 'crypt_hoard')).toBe(2);
    expect(delta('item.drop', (d) => d[0] === 'crypt_hoard' && d[2] === 'common')).toBe(0);
    const [audit] = await auditsOf(p, 'dungeon.claim');
    const data = audit!.data as { items: number; itemsSalvaged: number };
    expect(delta('item.drop', (d) => d[0] === 'crypt' || d[0] === 'crypt_hoard')).toBe(
      data.items + data.itemsSalvaged,
    );
    await expectReconciled();
  });

  it('window rule: a run started one day and claimed the next counts each on its own day', async () => {
    const p = await newPlayer();
    await makeCryptReady(database.db, p.id, 'warrior', 16, { gear: false });
    nowMs = Date.parse('2026-11-20T23:59:30Z');
    const entered = await call(p, 'POST', '/dungeon', { dungeonId: 'namelessCrypt' }, null);
    expect(entered.json()).toMatchObject({ run: {} });
    nowMs = Math.max(
      Date.parse(entered.json<{ run: { endsAt: string } }>().run.endsAt),
      Date.parse('2026-11-21T00:00:10Z'),
    );
    const claimed = await call(p, 'POST', '/dungeon/claim');
    expect(claimed.json<{ result: { outcome: string } }>().result.outcome).toBe('failed');

    const day20 = (await loadRollups(database.db, { from: '2026-11-20', to: '2026-11-20' })).rows;
    const day21 = (await loadRollups(database.db, { from: '2026-11-21', to: '2026-11-21' })).rows;
    expect(total(day20, 'crypt.start')).toBe(1);
    expect(total(day20, 'crypt.claim')).toBe(0);
    expect(total(day21, 'crypt.start')).toBe(0);
    expect(total(day21, 'crypt.claim', (d) => d[1] === 'lost' && d[2] === 'no_hoard')).toBe(1);
    await expectReconciled();
  });
});

describe('quests and contracts', () => {
  it('a story turn-in (replayed) and a targeted contract reward', async () => {
    const p = await newPlayer();
    const before = await rollups();
    await call(p, 'POST', '/quests', { kind: 'story', questId: 'furrowsOfTheDead' }, null);
    await call(p, 'POST', '/activity', { areaId: 'abandonedFields' });
    advance(HOUR);
    const board = (await call(p, 'GET', '/quests', undefined, null)).json<QuestBoardResponse>();
    const story = board.quests.find((q) => q.questId === 'furrowsOfTheDead')!;
    const key = randomUUID();
    expect((await call(p, 'POST', `/quests/${story.id}/turn-in`, undefined, key)).statusCode).toBe(
      200,
    );
    await call(p, 'POST', `/quests/${story.id}/turn-in`, undefined, key);

    expect((await call(p, 'POST', '/activity/stop', undefined, null)).statusCode).toBe(200);
    // A level-20 hero past the Gravewarden, on a day whose board offers a targeted contract.
    await database.db
      .update(characters)
      .set({ level: 20, progress: { gravewardenDefeated: true } })
      .where(eq(characters.id, p.id));
    let offer: QuestBoardResponse['contracts']['offers'][number] | undefined;
    for (let day = 0; day < 20 && !offer; day++) {
      const b = (await call(p, 'GET', '/quests', undefined, null)).json<QuestBoardResponse>();
      offer = b.contracts.offers.find((o) => o.rewardSlots.length > 0);
      if (!offer) advance(24 * HOUR);
    }
    if (!offer) throw new Error('no targeted contract in 20 days');
    const accepted = await call(
      p,
      'POST',
      '/quests',
      { kind: 'contract', slot: offer.slot, rewardSlot: 'neck' },
      null,
    );
    expect(accepted.statusCode).toBe(201);
    const quest = accepted
      .json<QuestBoardResponse>()
      .quests.find((q) => q.questId === offer.templateId)!;
    await database.db
      .update(characterQuests)
      .set({ progress: quest.objectives.map((o) => ('count' in o ? o.count : 1)) })
      .where(eq(characterQuests.id, quest.id));
    expect((await call(p, 'POST', `/quests/${quest.id}/turn-in`)).statusCode).toBe(200);

    const rows = await rollups();
    const delta = (
      m: RollupRow['metric'],
      f: (d: RollupRow['dims']) => boolean = () => true,
      field: 'events' | 'amount' = 'events',
    ) => total(rows, m, f, field) - total(before, m, f, field);
    expect(
      delta(
        'quest.reward',
        (d) => d[0] === 'story' && d[1] === 'furrowsOfTheDead' && d[2] === 'no_item',
      ),
    ).toBe(1);
    expect(delta('gold.in', (d) => d[0] === 'quest', 'amount')).toBe(40);
    expect(delta('quest.reward', (d) => d[0] === 'contract' && d[2] === 'targeted')).toBe(1);
    expect(delta('item.drop', (d) => d[0] === 'contract' && d[2] === 'epic')).toBe(1);
    await expectReconciled();
  });
});

describe('report', () => {
  it('has a snapshot of equipped gear and build signatures', async () => {
    const report = await buildTelemetryReport(database.db, { from: null, to: null });
    expect(report.snapshot.equippedCharacters).toBeGreaterThanOrEqual(1);
    expect(report.snapshot.builds.some((b) => b.classId === 'warrior')).toBe(true);
    expect(report.snapshot.usage.some((u) => u.kind === 'base')).toBe(true);
  });

  it('builds signatures from top affixes, effects and two-piece sets', () => {
    const affixes = (...ids: string[]) => ids.map((affixId) => ({ affixId }));
    expect(
      buildSignature([
        { affixes: affixes('crit', 'health'), effect_id: 'emberWake', set_id: null },
        { affixes: affixes('crit', 'armor'), effect_id: null, set_id: 'vigil' },
        { affixes: affixes('crit', 'health', 'speed'), effect_id: null, set_id: 'vigil' },
        { affixes: affixes('speed'), effect_id: null, set_id: 'choir' },
      ]),
    ).toBe('crit+health+speed | effect:emberWake | set:vigil');
    expect(buildSignature([])).toBe('no affixes');
  });

  it('holds no personal data: no account or character ids, emails or names', async () => {
    const report = await buildTelemetryReport(
      database.db,
      { from: null, to: null },
      { reconcile: true },
    );
    const text = `${JSON.stringify(report)}\n${renderTelemetryReport(report)}`;
    expect(players.length).toBeGreaterThan(5);
    for (const p of players) {
      for (const secret of [p.id, p.accountId, p.email, p.name, p.token])
        expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    const stored = await database.db.select().from(telemetryDaily);
    expect(JSON.stringify(stored)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@/i);
  });

  it('renders every section and reconciles with the audit log', async () => {
    const report = await buildTelemetryReport(
      database.db,
      { from: null, to: null },
      { reconcile: true },
    );
    const text = renderTelemetryReport(report);
    for (const heading of [
      'Gold  in',
      'Drops by source and rarity',
      'Drops by area or crypt tier',
      'What became of drops',
      'Crypt tiers',
      'Quest and contract turn-ins',
      'Forge',
      'Materials',
      'Farming',
      'Equipped now',
      'Audit log reconciliation: all',
    ]) {
      expect(text).toContain(heading);
    }
    // A window with no rows shows the empty state.
    const empty = await buildTelemetryReport(database.db, { from: '2020-01-01', to: '2020-01-02' });
    expect(renderTelemetryReport(empty)).toContain('No telemetry recorded in this window.');
  });
});
