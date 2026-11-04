/**
 * Phase 1 exit criteria, end to end through the HTTP API with a simulated server clock (ticket 1.9,
 * GDD §15 Phase 1): a new player can register, create a character, farm the starter area, earn XP
 * and loot, equip an item, leave the game, return later and see valid offline progress — with no
 * duplication or reward exploits.
 *
 * "Valid" is checked against the server's own records: every credited millisecond, gold piece and
 * item is accounted for by exactly one `activity.reward` audit entry, offline time stops at the cap,
 * and replaying requests or the old session grants nothing. The browser version of this flow is
 * `tools/e2e/farm-loop.mjs` (CI job `e2e`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { SettleResponse } from '../activity/routes.js';
import type { InventoryView } from '../inventory/routes.js';
import { auditLog, characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = 3 * HOUR;

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-02T08:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

describe('Phase 1 exit criteria', () => {
  it('register → create → farm → loot → equip → leave → return with valid offline progress', async () => {
    const credentials = { email: 'wanderer@graumark.test', password: 'ashes-and-iron-42' };
    let token: string | undefined;
    const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
      app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        cookies: token ? { [SESSION_COOKIE]: token } : {},
      });

    // 1. Register (real account, session cookie).
    const reg = await api('POST', '/api/auth/register', {
      ...credentials,
      displayName: 'Wanderer',
    });
    expect(reg.statusCode).toBe(201);
    token = cookieOf(reg);
    expect(token).toBeDefined();

    // 2. Create a character; it becomes the active one.
    const created = await api('POST', '/api/characters', {
      name: 'Aldric',
      classId: 'warrior',
      appearance: { banner: 'ash' },
    });
    expect(created.statusCode).toBe(201);
    const characterId = created.json<{ character: { id: string } }>().character.id;
    const base = `/api/characters/${characterId}`;

    // 3. Farm the starter area.
    expect((await api('POST', `${base}/activity`, { areaId: 'abandonedFields' })).statusCode).toBe(
      201,
    );

    // 4. Earn XP and loot from server time (polling settle during active play).
    let xp = 0;
    let itemsSeen = 0;
    for (let i = 0; i < 6; i++) {
      nowMs += 5 * MIN;
      const res = await api('POST', `${base}/activity/settle`);
      expect(res.statusCode).toBe(200);
      const { summary } = res.json<SettleResponse>();
      xp += summary.xpGained;
      itemsSeen += summary.itemsGained;
    }
    expect(xp).toBeGreaterThan(0);
    expect(itemsSeen).toBeGreaterThan(0);

    // 5. Equip an item the class can use; derived stats change server-side.
    const inv = (await api('GET', `${base}/inventory`)).json<InventoryView>();
    expect(inv.inventory.length).toBe(itemsSeen);
    let equipped: InventoryView | null = null;
    for (const item of inv.inventory) {
      const res = await api('POST', `${base}/items/${item.id}/equip`);
      if (res.statusCode === 200) {
        equipped = res.json<InventoryView>();
        break;
      }
      expect(res.statusCode).toBe(422); // wrong class for this drop
    }
    expect(equipped?.equipped).toHaveLength(1);
    expect(equipped!.stats).not.toEqual(inv.stats);
    const equippedId = equipped!.equipped[0]!.id;
    const leftAt = nowMs;

    // 6. Leave the game: log out. The old session is revoked.
    const oldToken = token;
    expect((await api('POST', '/api/auth/logout')).statusCode).toBe(204);
    expect((await api('GET', '/api/account')).statusCode).toBe(401);

    // 7. Return 5 hours later (cap: 3 h after the last client contact).
    nowMs += 5 * HOUR;
    token = undefined;
    const login = await api('POST', '/api/auth/login', credentials);
    expect(login.statusCode).toBe(200);
    token = cookieOf(login);
    expect(token).not.toBe(oldToken);

    const list = (await api('GET', '/api/characters')).json<{ activeCharacterId: string }>();
    expect(list.activeCharacterId).toBe(characterId);

    // 8. The return summary: valid, capped offline progress.
    const back = await api('POST', `${base}/activity/settle`);
    expect(back.statusCode).toBe(200);
    const { summary, character } = back.json<SettleResponse>();
    expect(summary.since).toBe(new Date(leftAt).toISOString());
    expect(summary.cappedMs).toBe(2 * HOUR);
    // At most the cap plus the unfinished cycle carried over from before the absence.
    expect(summary.simulatedMs).toBeLessThanOrEqual(CAP + MIN);
    expect(summary.simulatedMs).toBeGreaterThan(CAP - 2 * MIN);
    expect(summary.kills).toBeGreaterThan(0);
    expect(summary.xpGained).toBeGreaterThan(0);
    expect(summary.goldGained).toBeGreaterThan(0);

    // Everything credited is accounted for by exactly one audit entry per settlement.
    const rewards = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, 'activity.reward')));
    const audit = rewards.map(
      (r) => r.data as { creditedMs: number; gold: number; items: number; cappedMs: number },
    );
    const sum = (k: 'creditedMs' | 'gold' | 'items' | 'cappedMs') =>
      audit.reduce((s, d) => s + d[k], 0);
    expect(sum('creditedMs')).toBe(30 * MIN + CAP);
    expect(sum('cappedMs')).toBe(2 * HOUR);
    const [row] = await database.db.select().from(characters).where(eq(characters.id, characterId));
    expect(row!.gold).toBe(sum('gold'));
    expect(character.gold).toBe(sum('gold'));
    const owned = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, characterId));
    expect(owned).toHaveLength(sum('items'));
    expect(owned.find((i) => i.id === equippedId)?.equippedSlot).not.toBeNull();

    // 9. No duplication: replaying the settle, or the logged-out session, grants nothing.
    const replay = (await api('POST', `${base}/activity/settle`)).json<SettleResponse>();
    expect(replay.summary.xpGained).toBe(0);
    expect(replay.summary.itemsGained).toBe(0);
    expect(replay.character.gold).toBe(character.gold);
    const stale = await app.inject({
      method: 'POST',
      url: `${base}/activity/settle`,
      cookies: { [SESSION_COOKIE]: oldToken! },
    });
    expect(stale.statusCode).toBe(401);
    // A body cannot inject rewards either (unknown properties are rejected outright).
    const forged = await api('POST', `${base}/activity`, {
      areaId: 'abandonedFields',
      gold: 1_000_000,
    });
    expect(forged.statusCode).toBe(400);
    const [after] = await database.db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId));
    expect(after!.gold).toBe(character.gold);
  });
});
