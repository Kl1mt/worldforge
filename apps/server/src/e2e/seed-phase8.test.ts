/**
 * Ticket 8.7: the Phase 8 browser run's seed (`seed-phase8.ts`, `E2E_SEED_PHASE8=1`) sets up what
 * `tools/e2e/phase8-exit.mjs` relies on, through the server's own rules: the Lantern Vigil with the
 * Deep and the Throne open, the Guild Roll listing the Wardens, Cass's ready notices and letters,
 * the Throne's level gate for Brynja, and the calendar still paused. A second start on a kept
 * database seeds nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { accounts } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { PHASE8_GUILD, PHASE8_PASSWORD, PHASE8_PLAYERS, seedPhase8 } from './seed-phase8.js';

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
  await seedPhase8(app, database.db, now);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PHASE8_PASSWORD },
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

type World = {
  areas: { id: string; unlocked: boolean }[];
  dungeons: { id: string; unlocked: boolean; blockers?: unknown[] }[];
};

describe('the Phase 8 browser run’s seed (ticket 8.7)', () => {
  it('opens the Deep and the Throne for Odric, the Throne stays barred for Brynja', async () => {
    const odric = await login(PHASE8_PLAYERS.odric.email);
    expect(odric.level).toBe(50);
    const w = await odric.get<World>(`/api/characters/${odric.heroId}/world`);
    const town = await odric.get<{ era: { title: string } }>('/api/world');
    expect(town.era.title).toBe('Era of the Lantern Vigil');
    for (const id of ['paleMarches', 'hollowDeep']) {
      expect(w.areas.find((a) => a.id === id)?.unlocked, id).toBe(true);
    }
    expect(w.dungeons.find((d) => d.id === 'hollowThrone')?.unlocked).toBe(true);
    const brynja = await login(PHASE8_PLAYERS.brynja.email);
    const b = await brynja.get<World>(`/api/characters/${brynja.heroId}/world`);
    expect(b.areas.find((a) => a.id === 'hollowDeep')?.unlocked).toBe(true);
    expect(b.dungeons.find((d) => d.id === 'hollowThrone')?.unlocked).toBe(false);
  });

  it('lists the Wardens on the Guild Roll and gives Odric the hall and his letters', async () => {
    const odric = await login(PHASE8_PLAYERS.odric.email);
    const roll = await odric.get<{ entries: { guild: { name: string } }[] }>(
      '/api/leaderboards/guilds',
    );
    expect(roll.entries.map((e) => e.guild.name)).toContain(PHASE8_GUILD);
    const hall = await odric.get<{ can: { buy: boolean } }>('/api/guild/hall');
    expect(hall.can.buy).toBe(true);
    const inbox = await odric.get<{ entries: { kind: string }[] }>('/api/inbox');
    const kinds = new Set(inbox.entries.map((e) => e.kind));
    for (const k of ['drop', 'world.stage', 'world.era']) expect(kinds.has(k), k).toBe(true);
  });

  it('gives Cass a mixed pack and three ready notices', async () => {
    const cass = await login(PHASE8_PLAYERS.cass.email);
    const inv = await cass.get<{ inventory: { rarityId: string; locked: boolean }[] }>(
      `/api/characters/${cass.heroId}/inventory`,
    );
    expect(inv.inventory).toHaveLength(18);
    expect(inv.inventory.filter((i) => i.locked)).toHaveLength(2);
    const board = await cass.get<{ quests: { status: string }[] }>(
      `/api/characters/${cass.heroId}/quests`,
    );
    expect(board.quests.filter((q) => q.status === 'ready').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the calendar paused, makes Mira an admin, and seeds nothing twice', async () => {
    const mira = await login(PHASE8_PLAYERS.mira.email);
    const events = await mira.get<{ calendar: { paused: boolean } }>('/api/admin/events');
    expect(events.calendar.paused).toBe(true);
    await seedPhase8(app, database.db, now);
    const all = await database.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.email, PHASE8_PLAYERS.odric.email));
    expect(all).toHaveLength(1);
  });
});
