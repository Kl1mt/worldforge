/**
 * Real-PostgreSQL races for leaderboard snapshots (ticket 5.2, docs/LEADERBOARDS.md "Races").
 * Runs when `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). A refresh
 * runs after the value transaction, under a per-hero advisory lock, and re-reads the state under
 * it. Each race runs a few rounds and asserts only what holds in every order:
 * - a score change racing board reads: every read shows the old or the new value, never another;
 *   afterwards the stored row is the new state's;
 * - two updates racing (equips and stray refreshes of one hero at once): once all are done, every
 *   row equals `computeScore` of the hero's current state, with no deadlock and no retry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  ITEM_BASES,
  canClassUseItem,
  generateItem,
  type EquipmentSlotId,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { itemInstances, leaderboardEntries, type Character } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { checkLeaderboards } from './check.js';
import { cliDeps } from './leaderboard-cli.js';
import { refreshHeroScores } from './snapshot.js';
import type { BoardView } from './routes.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;

describe.skipIf(!url)('real PostgreSQL: leaderboard snapshots race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2031-06-01T10:00:00Z');
  const now = () => new Date(nowMs);

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
    app = buildApp({
      database,
      auth: { now },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
      leaderboards: { readLimit: { max: 100_000, windowMs: 60_000 } },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const api = (who: TestAccount, method: 'GET' | 'POST', path: string, payload?: object) =>
    app.inject({
      method,
      url: path,
      ...(payload ? { payload } : {}),
      cookies: { [SESSION_COOKIE]: who.token },
    });

  /** A weapon of `rarity` in the hero's pack. */
  async function weapon(hero: Character, rarityId: RarityId, seed: number): Promise<string> {
    const base = ITEM_BASES.find(
      (b) =>
        b.slot === 'weapon' && !b.unique && b.minItemLevel <= 10 && canClassUseItem(b, 'warrior'),
    )!;
    const item = generateItem({ seed, itemLevel: 10, baseId: base.id, rarityId })!;
    const id = uuidv7();
    await database.db.insert(itemInstances).values({
      id,
      characterId: hero.id,
      baseId: item.baseId,
      rarityId: item.rarityId,
      itemLevel: item.itemLevel,
      affixes: item.affixes,
      seed: item.seed,
      source: 'test',
    });
    return id;
  }

  const gearRow = async (heroId: string) =>
    (
      await database.db
        .select()
        .from(leaderboardEntries)
        .where(
          and(
            eq(leaderboardEntries.characterId, heroId),
            eq(leaderboardEntries.metric, 'gearScore'),
          ),
        )
    )[0]!;

  it('a score change racing board reads shows the old or the new value, never another', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      nowMs += 60_000;
      const who = await insertAccount(database.db, { now: now() });
      const hero = await insertCharacter(database.db, who.id, { level: 12 });
      const weak = await weapon(hero, 'common', 100 + round);
      const strong = await weapon(hero, 'legendary', 200 + round);
      const slot: EquipmentSlotId = 'weapon';
      expect(
        (await api(who, 'POST', `/api/characters/${hero.id}/items/${weak}/equip`, { slot }))
          .statusCode,
      ).toBe(200);
      const before = (await gearRow(hero.id)).value;
      const reads = Array.from({ length: 12 }, (_, i) => async () => {
        // A growing head start, so reads land before, during and after the equip.
        await new Promise((r) => setTimeout(r, i * (round + 1)));
        const res = await api(who, 'GET', '/api/leaderboards/gearScore?limit=1');
        expect(res.statusCode).toBe(200);
        return res.json<{ board: BoardView }>().board.yours[0]!.value;
      });
      const [equip, ...seen] = await Promise.all([
        api(who, 'POST', `/api/characters/${hero.id}/items/${strong}/equip`, { slot }),
        ...reads.map((r) => r()),
      ]);
      expect(equip.statusCode).toBe(200);
      const after = (await gearRow(hero.id)).value;
      expect(after).toBeGreaterThan(before);
      for (const v of seen) expect([before, after]).toContain(v);
    }
    expect(transactionStats.retries).toBe(retries);
  }, 60_000);

  it('two updates racing leave every row equal to the current state', async () => {
    const retries = transactionStats.retries;
    const deps = cliDeps(database.db);
    for (let round = 0; round < ROUNDS; round++) {
      nowMs += 60_000;
      const who = await insertAccount(database.db, { now: now() });
      const hero = await insertCharacter(database.db, who.id, { level: 14 });
      const items = await Promise.all(
        (['common', 'uncommon', 'rare', 'epic', 'legendary'] as const).map((r, i) =>
          weapon(hero, r, 300 + round * 10 + i),
        ),
      );
      const equips = items.map(
        (id) => () =>
          api(who, 'POST', `/api/characters/${hero.id}/items/${id}/equip`, { slot: 'weapon' }),
      );
      const strays = Array.from({ length: 6 }, () => () => refreshHeroScores(deps, hero.id, now()));
      const all = [...equips, ...strays];
      // Vary the order per round.
      const order = round % 2 === 0 ? all : [...all].reverse();
      const results = await Promise.all(order.map((f) => f()));
      for (const r of results) if (typeof r === 'object') expect(r.statusCode).toBe(200);
      const report = await checkLeaderboards(deps);
      expect(report.problems.filter((p) => p.characterId === hero.id)).toEqual([]);
    }
    expect(transactionStats.retries).toBe(retries);
  }, 60_000);
});
