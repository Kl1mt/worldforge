/**
 * The Phase 6 Prismatic step of the journey (ticket 6.4) on its own. The setup is seeded like
 * 6.3's Heroic step: the hero is made through the API, then set to level 34 with the crypt's tier
 * III and the Ashen Warden behind it, wearing the Depths' top Legendaries +10.
 *
 * A Prismatic drop is rare (about 1 in 16 Legendary or Mythic rolls in the Heroic crypt), so the
 * run's server seed is pinned (CLAUDE.md "Writing tests that don't flake"): after the run starts,
 * its stored secret is replaced by one that game-core's own replay shows dropping a Prismatic
 * item. Everything else is played through the API: the claim stores it, the pack shows it, it is
 * worn and upgraded at the Forge (it stays Prismatic), the hero's Gear Score names it, it is not
 * tradeable under the default switches, and the boards check finds no wrong value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import {
  canClassUseItem,
  equipmentSlotsForKind,
  MATERIAL_IDS,
  findItemBase,
  type Scores,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { characterMaterials, characters, dungeonRuns, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { replayRun } from '../dungeon/routes.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { HOUR, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-12T08:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const now = () => new Date(nowMs);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: 3 * HOUR, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface ViewItem {
  id: string;
  baseId: string;
  variant: string | null;
  binding: string;
  tradeable: boolean;
  source: string;
  equippedSlot: string | null;
}

describe('journey: a Prismatic find (Phase 6, ticket 6.4)', () => {
  it('drops in the Heroic crypt, is stored and shown, worn, forged, scored and stays untradeable', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'prism@graumark.test',
      displayName: 'Prism',
      name: 'Iriel',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 34,
        experience: 0,
        gold: 200_000,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 39, 'legendary', 'prismatic-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    // Forge stock for the upgrade below (materials are not what this step is about).
    await db.delete(characterMaterials).where(eq(characterMaterials.characterId, hero.characterId));
    await db.insert(characterMaterials).values(
      MATERIAL_IDS.map((materialId) => ({
        characterId: hero.characterId,
        materialId,
        quantity: 10_000,
      })),
    );
    hero.state.level = 34;
    const { api, keyed, base } = hero;

    // Enter the Heroic crypt, then pin the run's seed to one that drops a Prismatic item.
    const start = await api('POST', `${base}/dungeon`, { dungeonId: 'namelessCrypt', tier: 4 });
    expect(start.statusCode, start.body).toBe(201);
    const [run] = await db
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.characterId, hero.characterId))
      .orderBy(desc(dungeonRuns.startedAt))
      .limit(1);
    const pack = (await hero.inventory()).inventory.length;
    let secret: string | null = null;
    for (let i = 0; i < 2_000 && !secret; i++) {
      const candidate = `prismatic-journey:${i}`;
      const r = replayRun({ ...run!, seedSecret: candidate }, pack, null);
      const found = r.items.find((x) => x.variant === 'prismatic');
      if (found && canClassUseItem(findItemBase(found.baseId)!, 'warrior')) secret = candidate;
    }
    expect(secret, 'a seed with a wearable Prismatic drop').not.toBeNull();
    await db.update(dungeonRuns).set({ seedSecret: secret! }).where(eq(dungeonRuns.id, run!.id));

    clock.set(run!.endsAt.getTime());
    expect((await api('POST', `${base}/dungeon/settle`)).statusCode).toBe(200);
    const claim = await keyed(`${base}/dungeon/claim`);
    expect(claim.statusCode, claim.body).toBe(200);

    // The pack shows it with its variant (A.12 draws its treatment from this field).
    const inv = (await hero.inventory()) as unknown as { inventory: ViewItem[] };
    const prism = inv.inventory.find((i) => i.variant === 'prismatic');
    expect(prism).toBeDefined();
    const stored = (
      await db.select().from(itemInstances).where(eq(itemInstances.id, prism!.id))
    )[0]!;
    expect(stored.variant).toBe('prismatic');
    expect(['legendary', 'mythic']).toContain(stored.rarityId);
    // "Tradeable: Prismatic" is off by default (and trading is closed): never tradeable now.
    expect(prism!.tradeable).toBe(false);
    if (prism!.source === 'hoard:namelessCrypt') expect(prism!.binding).toBe('account');

    // Worn: the Gear Score names it and counts it like Void.
    const slot = equipmentSlotsForKind(findItemBase(prism!.baseId)!.slot)[0]!;
    const equip = await api('POST', `${base}/items/${prism!.id}/equip`, { slot });
    expect(equip.statusCode, equip.body).toBe(200);
    const scores = (await api('GET', `${base}/scores`)).json<{ scores: Scores }>().scores;
    const line = scores.gearScore.lines.find((l) => l.id === slot)!;
    expect(line.counted).toBe(true);
    expect(line.detail).toContain('Prismatic');

    // Forged: an upgrade never removes the variant (and binds the item, like any forge work).
    const up = await keyed(`${base}/forge/upgrade`, { itemId: prism!.id });
    expect(up.statusCode, up.body).toBe(200);
    const after = (
      await db.select().from(itemInstances).where(eq(itemInstances.id, prism!.id))
    )[0]!;
    expect(after.variant).toBe('prismatic');
    expect(after.binding).toBe('account');

    // Boards: every stored value recomputes to itself.
    const report = await checkLeaderboards(cliDeps(db), 200, now());
    expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
  }, 180_000);
});
