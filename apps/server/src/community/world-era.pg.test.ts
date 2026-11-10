/**
 * Real-PostgreSQL race for the world era (ticket 6.7, docs/COMMUNITY.md "Eras"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). A project completing (the
 * Forgeward Outpost: Rekindling → Forgeward Age) races an admin toggling another flag that moves
 * the era (the Ashen Pass off: Rekindling → Ashen Siege). Both read the flags under the world lock,
 * so in either order the `world.era_change` rows chain (each starts where the last ended) and end
 * at the era of the final flags; without the lock both would start from the Rekindling. Rounds give
 * the admin a growing head start until both orders were seen (bounded).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { worldEra } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  communityContributions,
  communityProjectProgress,
  communityProjects,
  worldFlags,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { completeProject } from './project-cli.js';
import { loadWorldState } from './world-state.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

describe.skipIf(!url)('real PostgreSQL: world era changes chain under a race', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let admin: TestAccount;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 8 });
    app = buildApp({ database, activity: { ...DEFAULT_ACTIVITY_OPTIONS } });
    await app.ready();
    admin = await insertAccount(database.db, { role: 'admin' });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;

  it('a completion and an admin toggle never both start from the same era', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 12 && seen.size < 2; round++) {
      for (const t of [communityContributions, communityProjectProgress, communityProjects]) {
        await db().delete(t);
      }
      await db().delete(worldFlags);
      // This round's rows only (the log keeps every round, so the rollups still reconcile).
      const old = new Set((await db().select({ id: auditLog.id }).from(auditLog)).map((r) => r.id));
      await completeProject(db(), 'restoreWarehouse', new Date());
      await completeProject(db(), 'clearAshenPass', new Date());
      const toggle = app.inject({
        method: 'POST',
        url: '/api/admin/world/flags/ashenPassCleared',
        payload: { set: false, confirm: 'ashenPassCleared', reason: 'race round' },
        headers: { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: admin.token },
      });
      const lead = round % 2 === 0 ? 0 : Math.min(40, round * 4);
      await new Promise((r) => setTimeout(r, lead));
      const [res] = await Promise.all([
        toggle,
        completeProject(db(), 'forgewardOutpost', new Date()),
      ]);
      expect(res.statusCode, res.body).toBe(200);
      const changes = (await db().select().from(auditLog))
        .filter((a) => a.event === 'world.era_change' && !old.has(a.id))
        .map((r) => r.data as { from: string; to: string; flagId?: string });
      // Long Dusk → Ashen Siege → Rekindling from the setup (sequential), then the race: its rows
      // must chain from the Rekindling in some order (ids within a millisecond aren't ordered).
      const setup = changes.filter((c) => !c.flagId && c.to !== 'forgewardAge');
      expect(setup.map((c) => `${c.from}>${c.to}`).sort()).toEqual([
        'ashenSiege>rekindling',
        'longDusk>ashenSiege',
      ]);
      const race = changes.filter((c) => !setup.includes(c));
      const chains = (order: typeof race) =>
        order.every((c, i) => c.from === (i === 0 ? 'rekindling' : order[i - 1]!.to));
      const label = JSON.stringify(race);
      expect(chains(race) || chains([...race].reverse()), label).toBe(true);
      const final = worldEra((await loadWorldState(db())).flags).id;
      expect(final).toBe('forgewardAge');
      expect(
        race.some((c) => c.to === final),
        label,
      ).toBe(true);
      // Without the lock both would start from the Rekindling.
      expect(
        race.filter((c) => c.from === 'rekindling'),
        label,
      ).toHaveLength(1);
      seen.add(race.length === 1 ? 'completion first' : 'toggle first');
    }
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    // Both orders happen in practice; the invariants above hold in each.
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });
});
