/**
 * Ticket 9.2 on real PostgreSQL: the board and duel versions at a season boundary. Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`).
 * - Power 4 (the defence loadout) and duel rules 3 are planned once, even by servers starting
 *   together (advisory locks), and both wait for the end of the season under way;
 * - to the season's last moment the board keeps Power 3 and duels fight version 2; at its end the
 *   sweep writes Power 4 (= `computeScore` of the stored input) and the next duel fights version 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { computeScore, type Loadout } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accounts,
  auditLog,
  duels,
  gameSettings,
  leaderboardEntries,
  seasons,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount } from '../test/social.js';
import { arenaCalls, befriend, equipKit } from '../test/arena.js';
import {
  FORMULA_SCHEDULE_KEY,
  ensureFormulaSchedule,
  ensurePvpRulesPlan,
  FormulaVersionSource,
} from '../leaderboards/formulas.js';
import { refreshHeroScores, sweepLeaderboards } from '../leaderboards/snapshot.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const DAY = 86_400_000;

describe.skipIf(!url)('real PostgreSQL: skills versions at the season boundary (9.2)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  // Derived from the wall clock (CLAUDE.md "Dates"): noon UTC today; the season ends in 3 days.
  let t = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
  const at = () => new Date(t);
  const end = t + 3 * DAY;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
    await database.db
      .insert(seasons)
      .values([{ number: 1, startsAt: new Date(t - 20 * DAY), endsAt: new Date(end) }]);
    // Production before 9.2: every switch through 8.2 in force (Power 3, PvE Progress 6).
    const done = (metric: string, from: number, to: number) => ({
      metric,
      from,
      to,
      afterSeason: null,
      plannedAt: new Date(t - 30 * DAY).toISOString(),
    });
    await database.db.insert(gameSettings).values({
      key: FORMULA_SCHEDULE_KEY,
      value: { switches: [done('power', 1, 3), done('pveProgress', 1, 6)] },
      version: 1,
      updatedAt: at(),
    });
    app = buildApp({
      database,
      auth: { now: at, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: at },
    });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('plans once when servers start together, and waits for the season’s end', async () => {
    // Five instances planning at once: one switch each, one audit row each.
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await ensureFormulaSchedule(database.db, at());
        await ensurePvpRulesPlan(database.db, at());
        await new FormulaVersionSource(database.db, 0).pvpRulesAt(at());
      }),
    );
    const rows = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'arena.rules_schedule'));
    expect(rows).toHaveLength(1);
    const formulas = await ensureFormulaSchedule(database.db, at());
    expect(formulas.schedule.slice(2).map((s) => [s.metric, s.from, s.to, s.afterSeason])).toEqual([
      ['power', 3, 4, 1],
    ]);
    const plan = await ensurePvpRulesPlan(database.db, at());
    expect(plan.map((s) => [s.from, s.to, s.afterSeason])).toEqual([[2, 3, 1]]);
    await app.ready();
  });

  it('Power 3 and duel rules 2 to the last moment, Power 4 and rules 3 after it', async () => {
    const make = async (classId: 'warlock' | 'warrior') => {
      const who = await insertAccount(database.db, { now: at() });
      const hero = await insertCharacter(database.db, who.id, { classId, level: 24 });
      await database.db
        .update(accounts)
        .set({ activeCharacterId: hero.id })
        .where(eq(accounts.id, who.id));
      await equipKit(database.db, hero.id, classId, 23, 'rare', who.id);
      return { who, hero };
    };
    const a = await make('warlock');
    const b = await make('warrior');
    await befriend(database.db, a.who.id, b.who.id, 'friends');
    const l: Loadout = { actives: ['agony', 'corruption', 'soulBurn'], passive: 'malice' };
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/characters/${a.hero.id}/skills/presets/1`,
      payload: l,
      cookies: { [SESSION_COOKIE]: a.who.token },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const api = arenaCalls(app);
    expect((await api.setDefence(a.who, a.hero.id)).statusCode).toBe(200);
    const defence = (await api.setDefence(b.who, b.hero.id)).json<{
      defence: { defenceId: string };
    }>().defence.defenceId;

    const deps = cliDeps(database.db);
    const power = async () =>
      (
        await database.db
          .select()
          .from(leaderboardEntries)
          .where(
            and(
              eq(leaderboardEntries.characterId, a.hero.id),
              eq(leaderboardEntries.metric, 'power'),
            ),
          )
      )[0]!;
    const duel = async () => {
      const res = await api.duel(a.who, a.hero.id, defence, 'friendly');
      expect(res.statusCode, res.body).toBe(201);
      const rows = await database.db
        .select()
        .from(duels)
        .where(eq(duels.challengerCharacterId, a.hero.id));
      return rows.sort((x, y) => +x.foughtAt - +y.foughtAt).at(-1)!;
    };

    await refreshHeroScores(deps, a.hero.id, at());
    const before = await power();
    expect(before.formulaVersion).toBe(3);
    expect(before.input.loadout).toEqual(l);
    expect((await duel()).rulesVersion).toBe(2);

    t = end - 1;
    expect((await duel()).rulesVersion).toBe(2);
    await sweepLeaderboards(deps, at(), { batch: 50, cursor: null });
    expect((await power()).formulaVersion).toBe(3);

    t = end;
    expect((await duel()).rulesVersion).toBe(3);
    await sweepLeaderboards(deps, at(), { batch: 200, cursor: null });
    const after = await power();
    expect(after.formulaVersion).toBe(4);
    expect(after.value).toBe(computeScore('power', after.input, 4).value);
    // The trials, seeds and points are Power 3's: without the loadout the input scores exactly
    // Power 3 (how far a loadout moves Power is measured in docs/SKILLS.md, not pinned here).
    const plain = { ...after.input, loadout: null };
    expect(computeScore('power', plain, 4).value).toBe(computeScore('power', plain, 3).value);
  });
});
