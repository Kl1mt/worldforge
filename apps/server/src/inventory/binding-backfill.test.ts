import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  RARITY_IDS,
  generateItem,
  type EquipmentSlotId,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accounts,
  auditLog,
  dataBackfills,
  dungeonRuns,
  itemInstances,
  type ItemInstance,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { makeCryptReady } from '../test/dungeon.js';
import {
  ITEM_BINDING_BACKFILL_ID,
  backfillCharacterItems,
  backfillItemBinding,
} from './binding-backfill.js';

/** Ticket T.1: the item-binding backfill on rows written before T.1 (binding null). */

const HOUR = 3_600_000;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2031-07-01T12:00:00Z');
const now = () => new Date(nowMs);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

beforeEach(async () => {
  await db().delete(dataBackfills);
});

const db = () => database.db;
const rowsOf = (characterId: string) =>
  db()
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, characterId))
    .orderBy(itemInstances.id);
const row = async (id: string) =>
  (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;

async function hero(level = 16) {
  const who = await insertAccount(db());
  const c = await insertCharacter(db(), who.id, { level });
  await db().update(accounts).set({ activeCharacterId: c.id }).where(eq(accounts.id, who.id));
  return { who, id: c.id };
}

/** A row as code before T.1 wrote it: no binding, no bound account. */
async function legacy(
  h: { who: TestAccount; id: string },
  {
    rarityId = 'epic' as RarityId,
    source = 'farming',
    equippedSlot = null as EquipmentSlotId | null,
    upgradeLevel = 0,
    audited = null as 'activity.reward' | 'forge.craft' | null,
  } = {},
): Promise<string> {
  const item = generateItem({ seed: 11, itemLevel: 16, baseId: 'barbute', rarityId })!;
  const id = uuidv7();
  await db()
    .insert(itemInstances)
    .values({ id, characterId: h.id, ...item, source, equippedSlot, upgradeLevel });
  if (audited === 'activity.reward') {
    await writeAudit(db(), {
      event: 'activity.reward',
      accountId: h.who.id,
      characterId: h.id,
      data: { notableItems: [{ id, baseId: item.baseId, rarityId, seed: item.seed }] },
    });
  } else if (audited === 'forge.craft') {
    await writeAudit(db(), {
      event: 'forge.craft',
      accountId: h.who.id,
      characterId: h.id,
      data: { itemId: id, baseId: item.baseId, rarityId },
    });
  }
  return id;
}

const pick = (r: ItemInstance) => ({
  binding: r.binding,
  boundAccountId: r.boundAccountId,
  source: r.source,
  unprovenanced: r.unprovenanced,
});

describe('item-binding backfill', () => {
  it('sets the binding from known state and marks bind-on-equip rows without provenance', async () => {
    const h = await hero();
    const ids = {
      common: await legacy(h, { rarityId: 'common' }),
      audited: await legacy(h, { audited: 'activity.reward' }),
      missing: await legacy(h, { rarityId: 'legendary' }),
      worn: await legacy(h, { equippedSlot: 'head' }),
      forged: await legacy(h, {
        rarityId: 'legendary',
        upgradeLevel: 2,
        audited: 'activity.reward',
      }),
      quest: await legacy(h, { source: 'quest' }),
      crafted: await legacy(h, { source: 'forge', audited: 'forge.craft' }),
      mythicMissing: await legacy(h, { rarityId: 'mythic', source: 'forge' }),
      merchant: await legacy(h, { rarityId: 'uncommon', source: 'merchant' }),
    };
    const result = await backfillItemBinding(db(), { now });
    expect(result).toMatchObject({ id: ITEM_BINDING_BACKFILL_ID, ran: true, skipped: 0 });
    const bound = { binding: 'account', boundAccountId: h.who.id, unprovenanced: false };
    const open = { binding: 'equip', boundAccountId: null };
    expect(await row(ids.common)).toMatchObject(bound);
    expect(await row(ids.audited)).toMatchObject({ ...open, unprovenanced: false });
    expect(await row(ids.missing)).toMatchObject({ ...open, unprovenanced: true });
    expect(await row(ids.worn)).toMatchObject(bound);
    expect((await row(ids.worn)).firstEquippedAt?.getTime()).toBe(nowMs);
    expect(await row(ids.forged)).toMatchObject(bound);
    expect((await row(ids.forged)).firstEquippedAt).toBeNull();
    expect(await row(ids.quest)).toMatchObject(bound);
    expect(await row(ids.crafted)).toMatchObject({ ...open, unprovenanced: false });
    expect(await row(ids.mythicMissing)).toMatchObject({ ...open, unprovenanced: true });
    expect(await row(ids.merchant)).toMatchObject(bound);
    const [done] = await db()
      .select()
      .from(dataBackfills)
      .where(eq(dataBackfills.id, ITEM_BINDING_BACKFILL_ID));
    expect(done?.data).toMatchObject({ unprovenanced: expect.any(Number) });
  });

  it('runs once; a forced re-run changes nothing', async () => {
    const h = await hero();
    await legacy(h, { rarityId: 'rare' });
    await legacy(h, { rarityId: 'legendary' });
    expect((await backfillItemBinding(db(), { now })).ran).toBe(true);
    const after = await rowsOf(h.id);
    expect(await backfillItemBinding(db(), { now })).toMatchObject({ ran: false, items: 0 });
    nowMs += HOUR;
    expect(await backfillItemBinding(db(), { now, force: true })).toMatchObject({
      ran: true,
      items: 0,
      skipped: 0,
    });
    expect(await rowsOf(h.id)).toEqual(after);
    // The forced run wrote no audit rows either.
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.characterId, h.id), eq(auditLog.event, 'item.provenance'))),
    ).toHaveLength(0);
  });

  it('resumes after an interruption and ends where one clean run would', async () => {
    const a = await hero();
    const b = await hero();
    const seed = async (h: { who: TestAccount; id: string }) => [
      await legacy(h, { rarityId: 'common' }),
      await legacy(h, { audited: 'activity.reward' }),
      await legacy(h, { rarityId: 'legendary' }),
      await legacy(h, { equippedSlot: 'head' }),
    ];
    const aIds = await seed(a);
    const bIds = await seed(b);
    // A crash in the middle of a's transaction leaves a untouched.
    await expect(
      withTransaction(db(), async (tx) => {
        await backfillCharacterItems(tx, a.id, now());
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    expect((await rowsOf(a.id)).every((r) => r.binding === null)).toBe(true);
    // b finished before the process died, a didn't; nothing was recorded as done.
    await withTransaction(db(), (tx) => backfillCharacterItems(tx, b.id, now()));
    const bDone = await rowsOf(b.id);
    expect(bDone.every((r) => r.binding !== null)).toBe(true);
    const [none] = await db()
      .select()
      .from(dataBackfills)
      .where(eq(dataBackfills.id, ITEM_BINDING_BACKFILL_ID));
    expect(none).toBeUndefined();

    nowMs += HOUR;
    const rerun = await backfillItemBinding(db(), { now });
    expect(rerun.skipped).toBe(0);
    // b was not touched again; a ended exactly as b did (same state per seeded row). Rows are
    // paired by the ids `seed` returned, not by position: UUIDv7 ids minted in the same
    // millisecond sort in random order, so a's and b's id orders can differ.
    expect(await rowsOf(b.id)).toEqual(bDone);
    const state = async (ids: string[]) =>
      Promise.all(
        ids.map(async (id) => {
          const r = await row(id);
          return { ...pick(r), boundAccountId: r.boundAccountId && 'x' };
        }),
      );
    expect(await state(aIds)).toEqual(await state(bIds));
  });

  it('never overwrites what equip or the Forge set before it got there', async () => {
    const h = await hero();
    const id = await legacy(h, { audited: 'activity.reward' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/characters/${h.id}/items/${id}/equip`,
      cookies: { [SESSION_COOKIE]: h.who.token },
    });
    expect(res.statusCode, res.body).toBe(200);
    const equipped = await row(id);
    expect(equipped.binding).toBe('account');
    await backfillItemBinding(db(), { now, force: true });
    expect(await row(id)).toEqual(equipped);
  });

  it('crypt items: recovers the hoard and the chamber provenance from the stored runs', async () => {
    const h = await hero();
    await makeCryptReady(db(), h.id, 'warrior', 16);
    const enter = await app.inject({
      method: 'POST',
      url: `/api/characters/${h.id}/dungeon`,
      payload: { dungeonId: 'namelessCrypt' },
      cookies: { [SESSION_COOKIE]: h.who.token },
    });
    expect(enter.statusCode, enter.body).toBe(201);
    await db()
      .update(dungeonRuns)
      .set({ seedSecret: 't1-backfill-crypt' })
      .where(eq(dungeonRuns.characterId, h.id));
    nowMs += 2 * HOUR;
    const claim = await app.inject({
      method: 'POST',
      url: `/api/characters/${h.id}/dungeon/claim`,
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: h.who.token },
    });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json<{ result: { bossLoot: boolean } }>().result.bossLoot).toBe(true);
    const fromRun = (await rowsOf(h.id)).filter((r) => r.source !== 'test');
    const written = fromRun.map(pick);
    expect(written.some((r) => r.source === 'hoard:namelessCrypt')).toBe(true);

    // Make it look like a pre-T.1 claim: one source for all, no binding, no ids in the audit row.
    const ids = fromRun.map((r) => r.id);
    await db()
      .update(itemInstances)
      .set({ binding: null, boundAccountId: null, source: 'dungeon:namelessCrypt' })
      .where(inArray(itemInstances.id, ids));
    const [claimAudit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, h.id), eq(auditLog.event, 'dungeon.claim')));
    const data = { ...(claimAudit!.data as Record<string, unknown>) };
    delete data.notableItems;
    await db().update(auditLog).set({ data }).where(eq(auditLog.id, claimAudit!.id));

    await backfillItemBinding(db(), { now });
    const restored = (await rowsOf(h.id)).filter((r) => ids.includes(r.id));
    // Exactly what the claim wrote with T.1 code: hoard back, bindings equal, nothing unproven.
    expect(restored.map(pick)).toEqual(written);
    const chamberNotable = fromRun
      .filter(
        (r) =>
          r.source.startsWith('dungeon:') &&
          RARITY_IDS.indexOf(r.rarityId) >= RARITY_IDS.indexOf('epic'),
      )
      .map((r) => r.id);
    const provenance = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, h.id), eq(auditLog.event, 'item.provenance')));
    if (chamberNotable.length === 0) {
      expect(provenance).toHaveLength(0);
    } else {
      expect(provenance).toHaveLength(1);
      expect(provenance[0]!.data).toEqual({ from: 'dungeon_runs', itemIds: chamberNotable });
    }
  });

  it('crypt items no stored run lists stay as they are and, if open, unprovenanced', async () => {
    const h = await hero();
    const id = await legacy(h, { rarityId: 'legendary', source: 'dungeon:namelessCrypt' });
    await backfillItemBinding(db(), { now });
    expect(await row(id)).toMatchObject({
      binding: 'equip',
      source: 'dungeon:namelessCrypt',
      unprovenanced: true,
    });
  });
});
