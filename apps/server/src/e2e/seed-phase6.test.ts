/**
 * Ticket 6.10: the Phase 6 browser run's seed (`seed-phase6.ts`, `E2E_SEED_PHASE6=1`) sets up what
 * `tools/e2e/phase6-exit.mjs` relies on, through the server's own rules: the world, the event, and
 * three accounts that can log in, with heroes the game's own unlock and awakening rules see as the
 * run expects. A second start on a kept database seeds nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  areaUnlockBlockers,
  awakeningCost,
  awakeningRefusal,
  dungeonUnlockBlockers,
  worldEra,
  type WorldFlags,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  characterMaterials,
  characters,
  cosmeticUnlocks,
  itemInstances,
  sessions,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { currentAndNextEvent, listEvents } from '../events/model.js';
import { createTestDatabase } from '../test/db.js';
import {
  PHASE6_COSMETICS,
  PHASE6_PASSWORD,
  PHASE6_PLAYERS,
  PHASE6_VARIANT_ITEMS,
  seedPhase6,
} from './seed-phase6.js';

const HOUR = 3_600_000;
let database: DatabaseHandle;
let app: FastifyInstance;
// The clock is injected, derived from the wall clock (CLAUDE.md "Dates").
const nowMs = Math.floor(Date.now() / HOUR) * HOUR;
const now = () => new Date(nowMs);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await seedPhase6(app, database.db, now);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function heroOf(email: string) {
  const [row] = await database.db
    .select({ account: accounts, character: characters })
    .from(accounts)
    .innerJoin(characters, eq(characters.accountId, accounts.id))
    .where(eq(accounts.email, email));
  return row!;
}

describe('the Phase 6 browser run seed (ticket 6.10)', () => {
  it('puts the town in the Forgeward Age with a Harvest of Bones under way', async () => {
    const flags = (await app.worldState.flags()) as WorldFlags;
    expect(worldEra(flags).id).toBe('forgewardAge');
    const { current } = currentAndNextEvent(await listEvents(database.db), now());
    expect(current?.definitionId).toBe('harvestOfBones');
    expect(current!.endsAt.getTime()).toBeGreaterThan(nowMs + 6 * 24 * HOUR);
  });

  it('seeds three accounts that log in with the run’s password, setup sessions revoked', async () => {
    for (const p of Object.values(PHASE6_PLAYERS)) {
      const { account } = await heroOf(p.email);
      const open = await database.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.accountId, account.id), isNull(sessions.revokedAt)));
      expect(open, p.email).toHaveLength(0);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: p.email, password: PHASE6_PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(account.role).toBe(p === PHASE6_PLAYERS.ysolde ? 'admin' : 'player');
    }
  });

  it('gives Hralda the late-game doors, a worn kit she can awaken and its price', async () => {
    const { account, character } = await heroOf(PHASE6_PLAYERS.hralda.email);
    expect(character.level).toBe(38);
    for (const area of ['ashfallVerge', 'cinderDepths'] as const) {
      expect(areaUnlockBlockers(area, character, character.progress)).toEqual([]);
    }
    expect(dungeonUnlockBlockers('tyrantsForge', character, character.progress)).toEqual([]);
    expect(dungeonUnlockBlockers('namelessCrypt', character, character.progress, 4)).toEqual([]);

    const worn = await database.db
      .select()
      .from(itemInstances)
      .where(
        and(eq(itemInstances.characterId, character.id), isNotNull(itemInstances.equippedSlot)),
      );
    expect(worn.length).toBeGreaterThan(0);
    const ready = worn.filter((i) => awakeningRefusal(i) === null);
    expect(ready.length).toBeGreaterThan(0);
    const cost = awakeningCost(ready[0]!);
    expect(character.gold).toBeGreaterThanOrEqual(cost.gold);
    const materials = new Map(
      (
        await database.db
          .select()
          .from(characterMaterials)
          .where(eq(characterMaterials.characterId, character.id))
      ).map((m) => [m.materialId as string, m.quantity]),
    );
    for (const id of ['tyrantsEmber', 'gravewardenSeal', 'soulShard'] as const) {
      expect(materials.get(id) ?? 0, id).toBeGreaterThanOrEqual(cost[id]);
    }

    const pack = await database.db
      .select()
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, character.id), isNull(itemInstances.equippedSlot)));
    for (const spec of PHASE6_VARIANT_ITEMS) {
      const item = pack.find((i) => i.baseId === spec.baseId && i.variant === spec.variant);
      expect(item, `${spec.variant} ${spec.baseId}`).toBeDefined();
      // generateAdminItem validated it; the run reads it as a Legendary of that variant.
      expect(item!.rarityId).toBe('legendary');
    }

    const owned = await database.db
      .select({ id: cosmeticUnlocks.cosmeticId })
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, account.id));
    expect(owned.map((o) => o.id).sort()).toEqual([...PHASE6_COSMETICS].sort());
  });

  it('opens the Depths to Tamsin but bars the Tyrant’s Forge by level', async () => {
    const { character } = await heroOf(PHASE6_PLAYERS.tamsin.email);
    expect(areaUnlockBlockers('cinderDepths', character, character.progress)).toEqual([]);
    expect(dungeonUnlockBlockers('tyrantsForge', character, character.progress)).toEqual([
      { kind: 'level', required: 36 },
    ]);
  });

  it('seeds nothing on a second start', async () => {
    const before = await database.db.select({ id: accounts.id }).from(accounts);
    await seedPhase6(app, database.db, now);
    const after = await database.db.select({ id: accounts.id }).from(accounts);
    expect(after).toHaveLength(before.length);
  });
});
