/**
 * Real-PostgreSQL races for the arena (ticket 5.5, docs/PVP.md "The arena"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Asserts only what holds
 * in every order: many challengers against one defender all fight a stored snapshot (the one before
 * or the one after a refresh racing them, never the live gear), a double submit with one key is one
 * duel, one account's racing rated duels never pass the daily limit, every stored duel replays to
 * its stored result, the audit log and telemetry reconcile, and no transaction is retried.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { RATED_DUELS_PER_DAY, duelFighter, simulateDuel } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { duelDefences, duels, itemInstances, type Character } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { arenaCalls, befriend, equipKit, setOffer } from '../test/arena.js';
import type { ArenaStateResponse, DuelView } from './routes.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;
const START = Date.parse('2026-11-09T12:00:00Z');

describe.skipIf(!url)('real PostgreSQL: duels race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let api: ReturnType<typeof arenaCalls>;
  const now = () => new Date(START);

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 4 + 2 });
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    api = arenaCalls(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;

  async function player(
    level: number,
    tag: string,
  ): Promise<{ who: TestAccount; hero: Character }> {
    const who = await insertAccount(db(), { now: now() });
    const hero = await insertCharacter(db(), who.id, { level, classId: 'mage' });
    await equipKit(db(), hero.id, 'mage', level - 1, 'rare', tag);
    return { who, hero };
  }

  async function defend(p: { who: TestAccount; hero: Character }) {
    const res = await api.setDefence(p.who, p.hero.id);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ArenaStateResponse>().defence!.defenceId;
  }

  async function expectReplays(duelIds: string[]) {
    for (const id of duelIds) {
      const [row] = await db().select().from(duels).where(eq(duels.id, id));
      const replay = simulateDuel({
        challenger: duelFighter(row!.challengerSnapshot),
        defender: duelFighter(row!.defenderSnapshot),
        seed: row!.seed,
        bracketId: row!.bracketId,
      });
      expect({ outcome: row!.outcome, events: row!.events }).toEqual({
        outcome: replay.outcome,
        events: replay.events,
      });
    }
  }

  it('many challengers against one defender, while the defender changes gear and refreshes', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const foe = await player(15, `foe-${round}`);
      const foeId = await defend(foe);
      const [before] = await db().select().from(duelDefences).where(eq(duelDefences.id, foeId));
      const challengers = await Promise.all(
        Array.from({ length: N }, (_, i) => player(12 + (i % 6), `c-${round}-${i}`)),
      );
      for (const c of challengers)
        await setOffer(db(), c.who.id, c.hero.id, '10-19', [foeId], now());
      // The defender re-gears (live items change) and refreshes the defence mid-race.
      const regear = async () => {
        await db().delete(itemInstances).where(eq(itemInstances.characterId, foe.hero.id));
        await equipKit(db(), foe.hero.id, 'mage', 18, 'epic', `regear-${round}`);
        return api.setDefence(foe.who, foe.hero.id);
      };
      const calls = challengers.map((c) => () => api.duel(c.who, c.hero.id, foeId, 'rated'));
      calls.splice(round % (N + 1), 0, regear);
      const results = await Promise.all(calls.map((f) => f()));
      for (const r of results) expect(r.statusCode, r.body).toBeLessThan(300);
      const [after] = await db().select().from(duelDefences).where(eq(duelDefences.id, foeId));
      const rows = await db().select().from(duels).where(eq(duels.defenceId, foeId));
      expect(rows).toHaveLength(N);
      for (const r of rows) {
        // Exactly one of the two stored snapshots, never a mix and never the live gear.
        const matches = [before!.snapshot, after!.snapshot].filter(
          (s) => JSON.stringify(s) === JSON.stringify(r.defenderSnapshot),
        );
        expect(matches.length).toBeGreaterThan(0);
        expect([before!.setAt.getTime(), after!.setAt.getTime()]).toContain(
          r.defenceSetAt.getTime(),
        );
      }
      await expectReplays(rows.map((r) => r.id));
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('a double submit with one key is one duel with one stored result', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const me = await player(20, `me-${round}`);
      const foe = await player(22, `twin-${round}`);
      const foeId = await defend(foe);
      await befriend(db(), me.who.id, foe.who.id, 'friends');
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: N }, () => api.duel(me.who, me.hero.id, foeId, 'friendly', key)),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(201);
      const bodies = results.map((r) => r.json<{ duel: DuelView }>().duel);
      // Replays come from the stored body (jsonb: key order may differ), so compare values.
      for (const b of bodies) expect(b).toEqual(bodies[0]);
      const rows = await db().select().from(duels).where(eq(duels.challengerAccountId, me.who.id));
      expect(rows).toHaveLength(1);
      expect(results.filter((r) => r.headers['idempotency-replayed'] === 'true')).toHaveLength(
        N - 1,
      );
    }
  });

  it('racing rated duels of one account never pass the daily limit', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const me = await player(25, `limit-${round}`);
      const foes = await Promise.all(
        Array.from({ length: RATED_DUELS_PER_DAY + 4 }, (_, i) => player(26, `lf-${round}-${i}`)),
      );
      const ids: string[] = [];
      for (const f of foes) ids.push(await defend(f));
      await setOffer(db(), me.who.id, me.hero.id, '20-29', ids, now());
      const results = await Promise.all(ids.map((id) => api.duel(me.who, me.hero.id, id, 'rated')));
      const ok = results.filter((r) => r.statusCode === 201);
      const refused = results.filter((r) => r.statusCode !== 201);
      expect(ok).toHaveLength(RATED_DUELS_PER_DAY);
      for (const r of refused)
        expect(r.json<{ error: { code: string } }>().error.code).toBe('no_duels_left');
      const rows = await db().select().from(duels).where(eq(duels.challengerAccountId, me.who.id));
      expect(rows).toHaveLength(RATED_DUELS_PER_DAY);
      // Each fought defence left the list exactly once.
      const state = (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>();
      expect(state.rated).toMatchObject({ used: RATED_DUELS_PER_DAY, left: 0 });
      expect(state.rated.offer!.opponents).toHaveLength(ids.length - RATED_DUELS_PER_DAY);
    }
    expect(transactionStats.retries).toBe(retries);
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
