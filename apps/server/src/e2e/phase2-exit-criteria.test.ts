/**
 * Phase 2 exit criteria, end to end through the HTTP API with a simulated server clock (ticket 2.8,
 * GDD §15 Phase 2): players can progress through several connected areas, complete quests, gather
 * resources, and clear the first dungeon and its boss.
 *
 * One warrior plays the way a player would, with B.1's pacing and no shortcuts (no level or gear
 * set in the database): farm the Abandoned Fields → move to the highest open area as levels come,
 * equipping better drops along the way → gather materials and level a profession → story quests and
 * contracts at the Tavern → buy, sell, salvage and craft once → run the Nameless Crypt until the
 * Gravewarden falls → the Sunken Abbey opens and is farmed.
 *
 * "Valid" is checked against the server's own records: every gold piece, item and material the
 * character holds at the end is accounted for by exactly one audit entry, and replays of the
 * value endpoints grant nothing. The browser version of this flow is `tools/e2e/phase2-exit.mjs`.
 * The player itself lives in `./journey.ts` (shared with the Phase 3 run, ticket 3.9).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STORY_QUEST_IDS, type ClassId } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { SettleResponse } from '../activity/routes.js';
import type { MaterialsResponse } from '../materials/store.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { AREA_ORDER, HOUR, STEP, expectHoldingsMatchAudit, startJourney } from './journey.js';

/** `E2E_CLASS=mage` etc. plays another class (all four pass; the default is the CI run). */
const CLASS_ID = (process.env.E2E_CLASS ?? 'warrior') as ClassId;
const CAP = 3 * HOUR;
/** Safety net: B.1 puts level 17 at ~33–38 h of farming; the run must finish well within this. */
const MAX_HOURS = 90;

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-02T08:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    // Sessions and the per-account rate limits (ticket 3.9) run on the same simulated clock, at
    // their production defaults: a visit's burst of requests stays within them.
    auth: { now: () => new Date(nowMs) },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('Phase 2 exit criteria', () => {
  it('fields → several areas → professions → quests and a contract → economy → crypt and Gravewarden → Sunken Abbey', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: CLASS_ID,
      email: 'pilgrim@graumark.test',
      displayName: 'Pilgrim',
      name: 'Hedda',
    });
    const { api, base, state } = hero;

    // 2. Farm. Each visit: settle (the return summary), equip better drops, Tavern, town, move on.
    expect(await hero.playPhase2(MAX_HOURS)).toBe(true);

    // 3. The whole Phase 2 loop happened within the time budget.
    expect(state.farmedHours).toBeLessThan(MAX_HOURS);
    expect([...state.areasFarmed]).toEqual(AREA_ORDER);
    expect(Object.values(state.economy)).toEqual([true, true, true, true]);
    expect(state.crypt.some((c) => c.bossDefeated)).toBe(true);
    expect(state.abbeyLockedBeforeBoss).toBe(true);
    const story = state.turnedIn.filter((q) => q.kind === 'story').map((q) => q.questId);
    expect(story).toEqual([...STORY_QUEST_IDS]);
    expect(state.turnedIn.filter((q) => q.kind === 'contract').length).toBeGreaterThan(0);

    // 4. Gathering: materials in storage and a profession above level 1.
    const mats = (await api('GET', `${base}/materials`)).json<MaterialsResponse>();
    expect(mats.materials.length).toBeGreaterThan(2);
    expect(Math.max(...mats.professions.map((p) => p.level))).toBeGreaterThan(1);

    // 5. Sunken Abbey: unlocked by level 17 + the Gravewarden, and farmed (its enemies were met).
    const w = await hero.world();
    expect(w.progress.gravewardenDefeated).toBe(true);
    // Every Graumark area; the Ashen Pass waits for the community (ticket 4.8), the Cinderwastes
    // for the Ashen Warden (ticket 6.1).
    expect(
      w.areas
        .filter((a) => !['ashenPass', 'ashfallVerge', 'cinderDepths'].includes(a.id))
        .every((a) => a.unlocked),
    ).toBe(true);
    expect(w.areas.find((a) => a.id === 'ashenPass')!.blockers).toContainEqual({
      kind: 'worldFlag',
      flag: 'ashenPassCleared',
    });
    nowMs += STEP;
    const abbey = (await api('POST', `${base}/activity/settle`)).json<SettleResponse>();
    expect(abbey.activity?.areaId).toBe('sunkenAbbey');
    expect(abbey.summary.kills).toBeGreaterThan(0);

    // 6. Everything held is accounted for by exactly one audit entry.
    const { row } = await expectHoldingsMatchAudit(database, hero.characterId);

    // For the record (docs/ROADMAP.md, Phase 2 retrospective).
    console.info(
      JSON.stringify({
        farmedHours: state.farmedHours,
        level: row.level,
        deaths: state.deaths,
        crypt: state.crypt,
        turnedIn: state.turnedIn.length,
      }),
    );
  }, 300_000);
});
