/**
 * Ticket 9.6: the Phase 9 browser run's seed (`seed-phase9.ts`, `E2E_SEED_PHASE9=1`) sets up what
 * `tools/e2e/phase9-exit.mjs` relies on, through the server's own rules: Aud on the default loadout
 * with her level's skills open and no defence; Torvald's Tyrant's Lesson ready to turn in, his
 * account's third slot and 8 offline hours, one companion owned and six free draws left. A second
 * start on a kept database seeds nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { accounts } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileShrine } from '../shrine/model.js';
import { createTestDatabase } from '../test/db.js';
import { PHASE9_PASSWORD, PHASE9_PLAYERS, seedPhase9 } from './seed-phase9.js';

const HOUR = 3_600_000;
let database: DatabaseHandle;
let app: FastifyInstance;
// The clock is injected, derived from the wall clock (CLAUDE.md "Dates").
const nowMs = Math.floor(Date.now() / HOUR) * HOUR;
const now = () => new Date(nowMs);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database, auth: { now }, activity: { ...DEFAULT_ACTIVITY_OPTIONS, now } });
  await seedPhase9(app, database.db, now);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PHASE9_PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const get = async <T>(url: string) => {
    const r = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } });
    expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
    return r.json<T>();
  };
  const { characters: heroes } = await get<{ characters: { id: string; level: number }[] }>(
    '/api/characters',
  );
  return { get, heroId: heroes[0]!.id, level: heroes[0]!.level };
}

type Skills = {
  activePreset: number;
  presets: { isDefault: boolean }[];
  unlocked: string[];
};

describe('the Phase 9 browser run’s seed', () => {
  it('Aud: level 30, the default loadout in force, her skills open, no defence yet', async () => {
    const aud = await login(PHASE9_PLAYERS.aud.email);
    expect(aud.level).toBe(30);
    const s = await aud.get<Skills>(`/api/characters/${aud.heroId}/skills`);
    expect(s.activePreset).toBe(1);
    expect(s.presets.every((p) => p.isDefault)).toBe(true);
    expect(s.unlocked).toEqual(expect.arrayContaining(['agony', 'corruption', 'malice']));
    const arena = await aud.get<{ defence: unknown }>(`/api/arena?characterId=${aud.heroId}`);
    expect(arena.defence).toBeNull();
  });

  it('Torvald: the lesson ready, the third slot and 8 hours, a companion and six draws', async () => {
    const tor = await login(PHASE9_PLAYERS.torvald.email);
    type Board = {
      skills: { questId: string; state: string; learned: boolean; questRowId: string | null }[];
      quests: { id: string; status: string }[];
    };
    const board = await tor.get<Board>(`/api/characters/${tor.heroId}/quests`);
    const lesson = board.skills.find((s) => s.questId === 'theTyrantsLesson')!;
    expect(lesson).toMatchObject({ state: 'active', learned: false });
    expect(board.quests.find((q) => q.id === lesson.questRowId)!.status).toBe('ready');
    const { materials } = await tor.get<{
      materials: { materialId: string; quantity: number }[];
    }>(`/api/characters/${tor.heroId}/materials`);
    expect(materials.find((m) => m.materialId === 'gravewardenSeal')?.quantity).toBe(2);
    const growth = await tor.get<{
      slots: { total: number; used: number };
      offline: { capMs: number; nextCapMs: number | null };
    }>('/api/account/growth');
    expect(growth.slots).toMatchObject({ total: 3, used: 1 });
    expect(growth.offline).toMatchObject({ capMs: 8 * HOUR, nextCapMs: null });
    const shrine = await tor.get<{ draws: number; pool: { cosmeticId: string; owned: boolean }[] }>(
      '/api/account/shrine',
    );
    expect(shrine.draws).toBe(6);
    expect(shrine.pool.filter((p) => p.owned).map((p) => p.cosmeticId)).toEqual([
      expect.stringMatching(/^companion\./),
    ]);
    const [row] = await database.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.email, PHASE9_PLAYERS.torvald.email));
    expect((await reconcileShrine(database.db, row!.id)).ok).toBe(true);
  });

  it('a second start on a kept database seeds nothing', async () => {
    const before = await database.db.select({ id: accounts.id }).from(accounts);
    await seedPhase9(app, database.db, now);
    expect(await database.db.select({ id: accounts.id }).from(accounts)).toHaveLength(
      before.length,
    );
  });
});
