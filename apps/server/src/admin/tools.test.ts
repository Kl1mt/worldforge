/**
 * Admin tools (ticket D.4): the permission matrix (anonymous / player / moderator / admin × every
 * tool), the test-account rules (cheat tools refused on normal accounts; test accounts absent from
 * boards, the season archive and so awards, matchmaking and trading), every tool's audit row,
 * idempotency, reconciliation after grants and removals, soft delete → restore → purge, and the
 * guard that no admin answer carries an email or password data.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MYTHIC_ITEMS,
  bossModifierOfWeek,
  validateItem,
  type GeneratedItem,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  accounts,
  auditLog,
  characters,
  duelDefences,
  itemInstances,
  leaderboardEntries,
  seasonStandings,
  telemetryDaily,
  telemetryDailyTest,
  tradeHolds,
  tradeOffers,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { setAccountRole } from '../social/roles.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  giveMaterials,
  insertTradeItem,
  insertTrader,
  setTradingSettings,
  tradeCalls,
} from '../test/trading.js';
import { shelfCalls } from '../test/shelf.js';
import { openWarehouse } from '../test/warehouse.js';
import { reconcileWithAudit, loadRollups } from '../telemetry/report.js';
import { refreshHeroScores } from '../leaderboards/snapshot.js';
import { snapshotDeps } from '../leaderboards/routes.js';
import { archiveSeason, scheduleSeason } from '../seasons/model.js';
import { SEASON_CLOSE_GRACE_MS } from '@worldforge/game-core';
import { drawOpponents } from '../arena/model.js';
import { loadTradeStanding } from '../trading/standing.js';
import { setTestAccount } from './test-accounts.js';
import { purgeDeletedHeroes } from './heroes.js';
import { RESTORE_WINDOW_MS } from './inspector.js';

const DAY = 86_400_000;
let clockMs = Date.parse('2031-03-03T10:00:00.000Z');
const now = () => new Date(clockMs);
const activity = { ...DEFAULT_ACTIVITY_OPTIONS, now };

type Who = 'anonymous' | 'player' | 'moderator' | 'admin';

describe('admin tools (D.4)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  const db = () => database.db;
  const who = {} as Record<Exclude<Who, 'anonymous'>, TestAccount>;
  /** Every response an admin received, for the no-email guard. */
  const seen: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
        tradeWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
      },
      activity,
    });
    await app.ready();
    // Every test may use the shelf and trades (ALL_TRADING_ON opens the shelf too).
    await openWarehouse(app, db(), now());
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    who.player = await insertAccount(db(), { name: 'Plain Pell', now: now() });
    who.moderator = await insertAccount(db(), {
      role: 'moderator',
      name: 'Warden Brann',
      now: now(),
    });
    who.admin = await insertAccount(db(), { role: 'admin', name: 'Castellan Ysolde', now: now() });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const call = async (
    actor: TestAccount | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key: string | null = randomUUID(),
  ): Promise<LightMyRequestResponse> => {
    const res = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: method === 'POST' && key ? { 'idempotency-key': key } : {},
      ...(actor ? { cookies: { [SESSION_COOKIE]: actor.token } } : {}),
    });
    if (actor?.role === 'admin') seen.push(res.body);
    return res;
  };
  const admin = (method: 'GET' | 'POST', url: string, payload?: object, key?: string | null) =>
    call(who.admin, method, url, payload, key);

  /** An account with one hero (and a test account when `test`). */
  async function target({ test = false, level = 10, gold = 500 } = {}) {
    const acc = await insertAccount(db(), { now: now() });
    if (test) await setTestAccount(db(), acc.handle, true);
    const hero = await insertCharacter(db(), acc.id, { level });
    await db().update(characters).set({ gold }).where(eq(characters.id, hero.id));
    return {
      acc,
      hero,
      base: `/api/admin/accounts/${acc.handle}`,
      heroUrl: `/api/admin/accounts/${acc.handle}/heroes/${hero.id}`,
    };
  }
  const lastAudit = async (accountId: string, event: string) =>
    (
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, event)))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(1)
    )[0];
  const heroRow = async (id: string) =>
    (await db().select().from(characters).where(eq(characters.id, id)))[0]!;
  const grantBody = (extra: object = {}) => ({
    baseId: 'longsword',
    rarityId: 'rare',
    itemLevel: 12,
    variant: null,
    upgradeLevel: 0,
    seed: 4242,
    reason: 'testing a sword',
    ...extra,
  });

  // ---------------------------------------------------------------------------------------------
  describe('permission matrix', () => {
    /** Every tool route with a body an admin would send (placeholders filled per run). */
    const ROUTES: { method: 'GET' | 'POST'; url: string; payload?: object }[] = [
      { method: 'GET', url: '/api/admin/accounts/:handle' },
      { method: 'GET', url: '/api/admin/accounts/:handle/heroes/:hero/view' },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/items/preview',
        payload: grantBody(),
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/items/grant',
        payload: grantBody(),
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/items/:item/remove',
        payload: { confirm: 'x', reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/gold',
        payload: { mode: 'refund', amount: 5, reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/materials',
        payload: { mode: 'refund', materials: { ironOre: 1 }, reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/xp',
        payload: { xp: 10, reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/level',
        payload: { level: 3, reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/delete',
        payload: { confirm: 'x', reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/restore',
        payload: { reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/rename',
        payload: { name: 'Renamedone', reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/progress',
        payload: {
          gravewardenDefeated: true,
          cryptTierCleared: 1,
          ashenWardenDefeated: false,
          reason: 'reason',
        },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/professions',
        payload: { professions: { mining: 5 }, reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/daily-reset',
        payload: { limits: ['merchant'], reason: 'reason' },
      },
      {
        method: 'POST',
        url: `/api/admin/accounts/:handle/heroes/:hero/quests/${randomUUID()}/complete`,
        payload: { reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/heroes/:hero/fast-forward',
        payload: { minutes: 5, reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/sessions/revoke',
        payload: { confirm: 'x', reason: 'reason' },
      },
      {
        method: 'POST',
        url: '/api/admin/accounts/:handle/login-lock/clear',
        payload: { reason: 'reason' },
      },
      { method: 'GET', url: '/api/admin/world' },
      {
        method: 'POST',
        url: '/api/admin/world/flags/ashenPassCleared',
        payload: { set: false, confirm: 'x', reason: 'reason' },
      },
    ];

    it('answers the not-found 404 to anonymous, players and moderators on every tool', async () => {
      const t = await target({ test: true });
      const item = await insertItem(db(), t.hero.id);
      const notFound = await app.inject({ method: 'GET', url: '/api/no-such-route' });
      for (const r of ROUTES) {
        const url = r.url
          .replace(':handle', t.acc.handle)
          .replace(':hero', t.hero.id)
          .replace(':item', item.id);
        for (const w of ['anonymous', 'player', 'moderator'] as const) {
          const res = await call(w === 'anonymous' ? null : who[w], r.method, url, r.payload);
          expect(res.statusCode, `${w} ${r.method} ${r.url}`).toBe(404);
          expect(res.json(), `${w} ${r.url}`).toEqual({
            ...notFound.json(),
            error: { ...notFound.json().error, message: expect.any(String) },
          });
        }
        // Even a malformed body is the same 404 for them (checked before validation).
        const res = await call(who.player, r.method, url, { junk: true });
        expect(res.statusCode).toBe(404);
      }
      // Nothing changed on the hero.
      expect((await heroRow(t.hero.id)).level).toBe(10);
      expect(
        await db().select().from(itemInstances).where(eq(itemInstances.id, item.id)),
      ).toHaveLength(1);
    });

    it('admins reach every route (not a 404)', async () => {
      const t = await target({ test: true });
      const item = await insertItem(db(), t.hero.id);
      for (const r of ROUTES) {
        const url = r.url
          .replace(':handle', t.acc.handle)
          .replace(':hero', t.hero.id)
          .replace(':item', item.id);
        const res = await admin(r.method, url, r.payload);
        // A quest that doesn't exist, a hero that isn't deleted, a confirmation typed wrong: but
        // never the route-level 404 a non-admin gets.
        if (res.statusCode === 404) expect(res.json().error.message, r.url).not.toBe('Not found.');
        expect(res.statusCode, `${r.url}: ${res.body}`).toBeLessThan(500);
      }
    });

    it('a role revoked by the CLI stops the next write (re-read in the transaction)', async () => {
      const t = await target({ test: true });
      const ex = await insertAccount(db(), { role: 'admin', now: now() });
      const ok = await call(ex, 'POST', `${t.heroUrl}/level`, {
        level: 4,
        reason: 'before revoke',
      });
      expect(ok.statusCode).toBe(200);
      await setAccountRole(db(), ex.handle, 'player');
      const res = await call(ex, 'POST', `${t.heroUrl}/level`, {
        level: 5,
        reason: 'after revoke',
      });
      expect(res.statusCode).toBe(404);
      expect((await heroRow(t.hero.id)).level).toBe(4);
    });

    it('no tool changes a role, and test accounts are only marked by the CLI', async () => {
      const root = join(__dirname);
      const files = readdirSync(root).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
      for (const f of files) {
        const text = readFileSync(join(root, f), 'utf8');
        expect(
          /\brole:\s/.test(text.replace(/select\(\{ role: accounts\.role \}\)/g, '')) &&
            /\.update\(accounts\)/.test(text) &&
            /set\(\{[^}]*\brole\b/.test(text),
          f,
        ).toBe(false);
        if (f !== 'test-accounts.ts')
          expect(
            /isTest:\s*(true|on|false)/.test(text) && /\.update\(accounts\)/.test(text),
            f,
          ).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('cheat tools: test accounts or the admin’s own account only', () => {
    const cheats = (heroUrl: string, questId: string) => [
      { url: `${heroUrl}/items/grant`, body: grantBody() },
      { url: `${heroUrl}/gold`, body: { mode: 'grant', amount: 100, reason: 'cheat gold' } },
      {
        url: `${heroUrl}/materials`,
        body: { mode: 'grant', materials: { ironOre: 5 }, reason: 'cheat ore' },
      },
      { url: `${heroUrl}/xp`, body: { xp: 1000, reason: 'cheat xp' } },
      { url: `${heroUrl}/level`, body: { level: 12, reason: 'cheat level' } },
      {
        url: `${heroUrl}/progress`,
        body: {
          gravewardenDefeated: true,
          cryptTierCleared: 2,
          ashenWardenDefeated: false,
          reason: 'cheat progress',
        },
      },
      { url: `${heroUrl}/professions`, body: { professions: { mining: 7 }, reason: 'cheat prof' } },
      {
        url: `${heroUrl}/daily-reset`,
        body: { limits: ['merchant', 'contracts', 'ratedDuels'], reason: 'cheat reset' },
      },
      { url: `${heroUrl}/quests/${questId}/complete`, body: { reason: 'cheat quest' } },
    ];

    it('refuses every cheat tool on a normal account and changes nothing', async () => {
      const t = await target();
      const before = await heroRow(t.hero.id);
      for (const c of cheats(t.heroUrl, randomUUID())) {
        const res = await admin('POST', c.url, c.body);
        expect(res.statusCode, c.url).toBe(403);
        expect(res.json().error.code).toBe('test_account_required');
      }
      const ff = await admin('POST', `${t.heroUrl}/fast-forward`, {
        minutes: 5,
        reason: 'cheat ff',
      });
      expect(ff.json().error.code).toBe('test_account_required');
      expect(await heroRow(t.hero.id)).toEqual(before);
      expect(
        await db().select().from(itemInstances).where(eq(itemInstances.characterId, t.hero.id)),
      ).toEqual([]);
    });

    it('allows them on a test account (no warning) and audits each with by, reason, before/after', async () => {
      const t = await target({ test: true });
      const events = [
        'admin.item.grant',
        'admin.gold',
        'admin.materials',
        'admin.xp',
        'admin.level',
        'admin.progress',
        'admin.professions',
        'admin.daily_reset',
      ];
      const list = cheats(t.heroUrl, randomUUID()).slice(0, 8);
      for (const [i, c] of list.entries()) {
        const res = await admin('POST', c.url, c.body);
        expect(res.statusCode, `${c.url}: ${res.body}`).toBe(200);
        expect(res.json().warning).toBeUndefined();
        const row = await lastAudit(t.acc.id, events[i]!);
        expect(row, events[i]).toBeDefined();
        expect(row!.characterId).toBe(t.hero.id);
        expect(row!.data).toMatchObject({
          by: who.admin.id,
          reason: (c.body as { reason: string }).reason,
        });
        expect(row!.data).toHaveProperty('after');
      }
      const hero = await heroRow(t.hero.id);
      expect(hero.level).toBe(12);
      expect(hero.progress).toMatchObject({ gravewardenDefeated: true, cryptTierCleared: 2 });
    });

    it('allows them on the admin’s own normal account with the public-boards warning', async () => {
      const hero = await insertCharacter(db(), who.admin.id, { level: 3 });
      const res = await admin(
        'POST',
        `/api/admin/accounts/${who.admin.handle}/heroes/${hero.id}/level`,
        {
          level: 6,
          reason: 'own test',
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toBe('public_boards');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('items', () => {
    it('previews with game-core’s generator and grants exactly the previewed item, account-bound, with provenance', async () => {
      const t = await target({ test: true, level: 20 });
      const pre = await admin('POST', `${t.heroUrl}/items/preview`, {
        baseId: 'longsword',
        rarityId: 'legendary',
        itemLevel: 20,
        variant: 'void',
        upgradeLevel: 3,
      });
      expect(pre.statusCode, pre.body).toBe(200);
      const { seed, item } = pre.json() as {
        seed: number;
        item: GeneratedItem & { upgradeLevel: number };
      };
      expect(validateItem(item)).toEqual([]);
      expect(item.variant).toBe('void');
      // A preview writes nothing.
      expect(
        await db().select().from(itemInstances).where(eq(itemInstances.characterId, t.hero.id)),
      ).toEqual([]);

      const res = await admin('POST', `${t.heroUrl}/items/grant`, {
        baseId: 'longsword',
        rarityId: 'legendary',
        itemLevel: 20,
        variant: 'void',
        upgradeLevel: 3,
        seed,
        reason: 'void testing',
      });
      expect(res.statusCode, res.body).toBe(200);
      const [row] = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, t.hero.id));
      expect(row).toMatchObject({
        source: 'admin',
        binding: 'account',
        boundAccountId: t.acc.id,
        upgradeLevel: 3,
        variant: 'void',
        seed,
        affixes: item.affixes,
        effectId: item.effectId ?? null,
      });
      expect(res.json().item.tradeable).toBe(false);
      const prov = await lastAudit(t.acc.id, 'item.provenance');
      expect(prov!.data).toEqual({ from: 'admin', itemIds: [row!.id] });
    });

    it('grants a Prismatic Mythic on a test account, refuses it on an Epic and on a normal account (ticket 6.4)', async () => {
      const t = await target({ test: true, level: 30 });
      const mythicBase = MYTHIC_ITEMS[0]!.baseId;
      const spec = { baseId: mythicBase, rarityId: 'mythic', itemLevel: 30, upgradeLevel: 0 };
      const pre = await admin('POST', `${t.heroUrl}/items/preview`, {
        ...spec,
        variant: 'prismatic',
      });
      expect(pre.statusCode, pre.body).toBe(200);
      const { seed, item } = pre.json() as { seed: number; item: GeneratedItem };
      expect(item.variant).toBe('prismatic');
      expect(validateItem(item)).toEqual([]);
      const res = await admin('POST', `${t.heroUrl}/items/grant`, {
        ...spec,
        variant: 'prismatic',
        seed,
        reason: 'prismatic testing',
      });
      expect(res.statusCode, res.body).toBe(200);
      const [row] = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, t.hero.id));
      expect(row).toMatchObject({ variant: 'prismatic', source: 'admin', binding: 'account' });
      // The item view carries the variant (A.12 draws from it).
      expect(res.json().item.variant).toBe('prismatic');

      const epic = await admin('POST', `${t.heroUrl}/items/preview`, {
        baseId: 'longsword',
        rarityId: 'epic',
        itemLevel: 20,
        variant: 'prismatic',
        upgradeLevel: 0,
      });
      expect(epic.statusCode).toBe(422);
      expect(epic.json().error.details.problems).toContain('variant prismatic on a epic item');

      const normal = await target({ level: 30 });
      const refused = await admin('POST', `${normal.heroUrl}/items/grant`, {
        ...spec,
        variant: 'prismatic',
        seed,
        reason: 'not here',
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('test_account_required');
    });

    it('grants an awakened +10 Legendary on a test account, and only an item the Forge could awaken (ticket 6.5b)', async () => {
      const t = await target({ test: true, level: 38 });
      const spec = {
        baseId: 'longsword',
        rarityId: 'legendary',
        itemLevel: 37,
        variant: 'void',
        upgradeLevel: 10,
        awakened: true,
      };
      const pre = await admin('POST', `${t.heroUrl}/items/preview`, spec);
      expect(pre.statusCode, pre.body).toBe(200);
      const { seed, item } = pre.json() as { seed: number; item: GeneratedItem };
      expect(item.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
      expect(validateItem(item)).toEqual([]);
      const res = await admin('POST', `${t.heroUrl}/items/grant`, {
        ...spec,
        seed,
        reason: 'awakening testing',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().item.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
      const [row] = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, t.hero.id));
      expect(row).toMatchObject({
        awakening: { option: 'effect', effectStrength: 1.1 },
        variant: 'void',
        upgradeLevel: 10,
        source: 'admin',
        binding: 'account',
      });
      expect(row!.awakenedAt).not.toBeNull();

      // At +9, or below item level 23, the Forge couldn't awaken it: refused in plain words.
      const at9 = await admin('POST', `${t.heroUrl}/items/preview`, { ...spec, upgradeLevel: 9 });
      expect(at9.statusCode).toBe(422);
      expect(at9.json().error.message).toBe('Only items at +10 can be awakened.');
      const low = await admin('POST', `${t.heroUrl}/items/preview`, { ...spec, itemLevel: 22 });
      expect(low.statusCode).toBe(422);
      expect(low.json().error.details.fields.awakened).toMatch(/item level 23/);
    });

    it('refuses an invalid combination with game-core’s reasons', async () => {
      const t = await target({ test: true });
      const res = await admin('POST', `${t.heroUrl}/items/preview`, {
        baseId: 'longsword',
        rarityId: 'common',
        itemLevel: 5,
        variant: 'void',
        upgradeLevel: 0,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_item');
      expect(res.json().error.details.problems.length).toBeGreaterThan(0);
    });

    it('is idempotent: a replay returns the same item and creates nothing more', async () => {
      const t = await target({ test: true });
      const key = randomUUID();
      const a = await admin('POST', `${t.heroUrl}/items/grant`, grantBody(), key);
      const b = await admin('POST', `${t.heroUrl}/items/grant`, grantBody(), key);
      expect(a.statusCode).toBe(200);
      expect(b.headers['idempotency-replayed']).toBe('true');
      expect(b.json()).toEqual(a.json());
      expect(
        await db().select().from(itemInstances).where(eq(itemInstances.characterId, t.hero.id)),
      ).toHaveLength(1);
      // Without a key: refused.
      const none = await admin('POST', `${t.heroUrl}/items/grant`, grantBody(), null);
      expect(none.statusCode).toBe(400);
      expect(none.json().error.code).toBe('idempotency_key_required');
      // Same key, another body: a conflict, not a second grant.
      const other = await admin('POST', `${t.heroUrl}/items/grant`, grantBody({ seed: 1 }), key);
      expect(other.statusCode).toBe(409);
    });

    it('removes from the pack, the gear, the warehouse and the shelf; refuses held and escrowed items', async () => {
      const t = await target();
      const pack = await insertItem(db(), t.hero.id);
      const worn = await insertItem(db(), t.hero.id, { equippedSlot: 'weapon' });
      const stored = await insertItem(db(), t.hero.id, { inWarehouse: true });
      const shelved = await insertItem(db(), t.hero.id, { rarityId: 'epic' });
      const s = shelfCalls(app);
      expect(
        (await s.move(t.acc.token, t.hero.id, 'deposit', { itemIds: [shelved.id] })).statusCode,
      ).toBe(200);
      const held = await insertItem(db(), t.hero.id);
      await db()
        .update(itemInstances)
        .set({ holdUntil: new Date(clockMs + DAY) })
        .where(eq(itemInstances.id, held.id));

      const remove = (itemId: string, confirm: string) =>
        admin('POST', `${t.base}/items/${itemId}/remove`, { confirm, reason: 'support removal' });
      const wrong = await remove(pack.id, 'Not The Name');
      expect(wrong.statusCode).toBe(422);
      expect(wrong.json().error.code).toBe('confirmation_mismatch');
      for (const [item, confirm, location] of [
        [pack, t.hero.name, 'pack'],
        [worn, t.hero.name, 'equipped'],
        [stored, t.hero.name, 'warehouse'],
        [shelved, t.acc.handle, 'shelf'],
      ] as const) {
        const res = await remove(item.id, confirm);
        expect(res.statusCode, `${location}: ${res.body}`).toBe(200);
        expect(res.json().removed.location).toBe(location);
        const row = await lastAudit(t.acc.id, 'admin.item.remove');
        expect(row!.data).toMatchObject({
          by: who.admin.id,
          location,
          before: { itemId: item.id },
          after: null,
        });
      }
      const refused = await remove(held.id, t.hero.name);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('item_held');
      // Another account's item: 404.
      const other = await target();
      const foreign = await insertItem(db(), other.hero.id);
      expect((await remove(foreign.id, t.hero.name)).statusCode).toBe(404);
      expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    });

    it('refuses an item in an open offer’s escrow', async () => {
      const a = await insertTrader(db(), now());
      const b = await insertTrader(db(), now());
      await befriendSince(db(), a, b, now());
      const item = await insertTradeItem(db(), a.hero.id);
      const sent = await tradeCalls(app).send(a, b, { give: { itemIds: [item.id] } });
      expect(sent.statusCode, sent.body).toBe(201);
      const res = await admin('POST', `/api/admin/accounts/${a.handle}/items/${item.id}/remove`, {
        confirm: a.hero.name,
        reason: 'support removal',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('item_in_escrow');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('currencies', () => {
    it('refunds and removes gold on any account; never below zero or into held gold', async () => {
      const t = await target({ gold: 300 });
      const refund = await admin('POST', `${t.heroUrl}/gold`, {
        mode: 'refund',
        amount: 200,
        reason: 'lost to a bug',
      });
      expect(refund.json().gold).toEqual({ before: 300, after: 500 });
      const noConfirm = await admin('POST', `${t.heroUrl}/gold`, {
        mode: 'remove',
        amount: 50,
        reason: 'duped gold',
      });
      expect(noConfirm.json().error.code).toBe('confirmation_mismatch');
      const tooMuch = await admin('POST', `${t.heroUrl}/gold`, {
        mode: 'remove',
        amount: 501,
        confirm: t.hero.name,
        reason: 'duped gold',
      });
      expect(tooMuch.statusCode).toBe(422);
      // 400 of the 500 are held after a trade: only 100 can go.
      await db()
        .insert(tradeHolds)
        .values({
          id: uuidv7(),
          characterId: t.hero.id,
          accountId: t.acc.id,
          offerId: await fakeAcceptedOffer(t.acc.id, t.hero.id),
          gold: 400,
          heldUntil: new Date(clockMs + DAY),
          createdAt: now(),
        });
      const intoHeld = await admin('POST', `${t.heroUrl}/gold`, {
        mode: 'remove',
        amount: 150,
        confirm: t.hero.name,
        reason: 'duped gold',
      });
      expect(intoHeld.statusCode).toBe(422);
      expect(intoHeld.json().error.details.onHold).toBe(400);
      const ok = await admin('POST', `${t.heroUrl}/gold`, {
        mode: 'remove',
        amount: 100,
        confirm: t.hero.name,
        reason: 'duped gold',
      });
      expect(ok.json().gold).toEqual({ before: 500, after: 400 });
      const row = await lastAudit(t.acc.id, 'admin.gold');
      expect(row!.data).toMatchObject({
        mode: 'remove',
        amount: 100,
        before: { gold: 500 },
        after: { gold: 400 },
      });
      // The hold was planted without a trade: take it away so the reconciliation stays exact.
      await db().delete(tradeHolds).where(eq(tradeHolds.characterId, t.hero.id));
    });

    it('removes materials only down to zero', async () => {
      const t = await target();
      await giveMaterials(db(), t.hero.id, { ironOre: 10 });
      const over = await admin('POST', `${t.heroUrl}/materials`, {
        mode: 'remove',
        materials: { ironOre: 11 },
        confirm: t.hero.name,
        reason: 'dupe',
      });
      expect(over.statusCode).toBe(422);
      const ok = await admin('POST', `${t.heroUrl}/materials`, {
        mode: 'remove',
        materials: { ironOre: 10 },
        confirm: t.hero.name,
        reason: 'dupe',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().materials.after.ironOre).toBeUndefined();
    });

    it('XP follows the normal level-up rule', async () => {
      const t = await target({ test: true, level: 1 });
      const res = await admin('POST', `${t.heroUrl}/xp`, {
        xp: 700 + 2800 + 10,
        reason: 'xp grant',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().after).toEqual({ level: 3, experience: 10 });
    });
  });

  /** A closed, accepted offer row to hang a hold on (holds reference an offer). */
  async function fakeAcceptedOffer(accountId: string, heroId: string) {
    const other = await insertAccount(db(), { now: now() });
    const otherHero = await insertCharacter(db(), other.id);
    const id = uuidv7();
    await db()
      .insert(tradeOffers)
      .values({
        id,
        senderAccountId: other.id,
        receiverAccountId: accountId,
        senderCharacterId: otherHero.id,
        receiverCharacterId: heroId,
        status: 'accepted',
        relation: 'friend',
        expiresAt: new Date(clockMs + DAY),
        closedAt: now(),
        createdAt: now(),
      });
    return id;
  }

  // ---------------------------------------------------------------------------------------------
  describe('progress, quests, fast-forward, sessions', () => {
    it('sets the Cinderwastes progress (ticket 6.2): the Depths, the Forge and the Tyrant', async () => {
      const t = await target({ test: true, level: 36 });
      const set = (forgeTyrantDefeated?: boolean) =>
        admin('POST', `${t.heroUrl}/progress`, {
          gravewardenDefeated: true,
          cryptTierCleared: 3,
          ashenWardenDefeated: true,
          ...(forgeTyrantDefeated === undefined ? {} : { forgeTyrantDefeated }),
          reason: 'test the Depths',
        });
      // The Warden alone opens the Depths and the Forge at 36; the Tyrant not yet slain.
      expect((await set()).statusCode).toBe(200);
      const world = await call(t.acc, 'GET', `/api/characters/${t.hero.id}/world`);
      const depths = world.json().areas.find((a: { id: string }) => a.id === 'cinderDepths');
      expect(depths).toMatchObject({ unlocked: true, blockers: [] });
      const forge = () =>
        call(t.acc, 'GET', `/api/characters/${t.hero.id}/dungeon`).then(
          (r) =>
            r.json().dungeons.find((d: { id: string }) => d.id === 'tyrantsForge') as {
              unlocked: boolean;
              tierCleared: number;
            },
        );
      expect(await forge()).toMatchObject({ unlocked: true, tierCleared: 0 });
      // Boss defeated: the Forge counts as cleared, PvE Progress counts the Tyrant.
      const res = await set(true);
      expect(res.json().after).toMatchObject({ forgeTyrantDefeated: true });
      expect((await forge()).tierCleared).toBe(1);
      expect((await lastAudit(t.acc.id, 'admin.progress'))!.data).toMatchObject({
        after: { forgeTyrantDefeated: true },
      });
      // Absent leaves it as it is; false removes it.
      expect((await set()).json().after.forgeTyrantDefeated).toBe(true);
      expect((await set(false)).json().after.forgeTyrantDefeated).toBe(false);
      expect((await forge()).tierCleared).toBe(0);
      // A normal account: refused like every cheat tool.
      const normal = await target({ level: 36 });
      const refused = await admin('POST', `${normal.heroUrl}/progress`, {
        gravewardenDefeated: true,
        cryptTierCleared: 3,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
        reason: 'not on a normal account',
      });
      expect(refused.json().error.code).toBe('test_account_required');
      expect((await heroRow(normal.hero.id)).progress).not.toHaveProperty('forgeTyrantDefeated');
    });

    it('sets "Heroic cleared" (ticket 6.3): crypt tier IV, counted by PvE Progress 4', async () => {
      const t = await target({ test: true, level: 34 });
      const res = await admin('POST', `${t.heroUrl}/progress`, {
        gravewardenDefeated: true,
        cryptTierCleared: 4,
        ashenWardenDefeated: true,
        reason: 'test the Heroic crypt',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().after).toMatchObject({ cryptTierCleared: 4 });
      const crypt = (await call(t.acc, 'GET', `/api/characters/${t.hero.id}/dungeon`)).json()
        .dungeons[0] as { tierCleared: number; tiers: { tier: number; unlocked: boolean }[] };
      expect(crypt.tierCleared).toBe(4);
      expect(crypt.tiers[3]).toMatchObject({ tier: 4, unlocked: true });
      const tooDeep = await admin('POST', `${t.heroUrl}/progress`, {
        gravewardenDefeated: true,
        cryptTierCleared: 5,
        ashenWardenDefeated: true,
        reason: 'no such tier',
      });
      expect(tooDeep.statusCode).toBe(400);
    });

    it('fast-forwards through the normal settlement (rewards from game-core, time moved only)', async () => {
      const t = await target({ test: true, level: 5 });
      expect(
        (await call(t.acc, 'POST', `/api/characters/${t.hero.id}/select`, {})).statusCode,
      ).toBeLessThan(300);
      const start = await call(t.acc, 'POST', `/api/characters/${t.hero.id}/activity`, {
        areaId: 'abandonedFields',
      });
      expect(start.statusCode, start.body).toBeLessThan(300);
      const res = await admin('POST', `${t.heroUrl}/fast-forward`, {
        minutes: 60,
        reason: 'skip an hour',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().creditedMs).toBe(3_600_000);
      const reward = await lastAudit(t.acc.id, 'activity.reward');
      expect(reward).toBeDefined();
      expect(await lastAudit(t.acc.id, 'admin.fast_forward')).toBeDefined();
      expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
      // Without an activity: refused.
      const idle = await target({ test: true });
      const none = await admin('POST', `${idle.heroUrl}/fast-forward`, {
        minutes: 5,
        reason: 'skip',
      });
      expect(none.json().error.code).toBe('no_activity');
    });

    it('logs an account out everywhere and clears its login lock (audited)', async () => {
      const t = await target();
      const before = await call(t.acc, 'GET', '/api/characters');
      expect(before.statusCode).toBe(200);
      const res = await admin('POST', `${t.base}/sessions/revoke`, {
        confirm: t.acc.handle,
        reason: 'compromised',
      });
      expect(res.json().revoked).toBe(1);
      expect((await call(t.acc, 'GET', '/api/characters')).statusCode).toBe(401);
      const clear = await admin('POST', `${t.base}/login-lock/clear`, { reason: 'locked out' });
      expect(clear.statusCode).toBe(200);
      expect(await lastAudit(t.acc.id, 'admin.sessions.revoke')).toBeDefined();
      expect(await lastAudit(t.acc.id, 'admin.login_lock.clear')).toBeDefined();
    });

    it('renames a hero (moderation) with an audit row', async () => {
      const t = await target();
      const res = await admin('POST', `${t.heroUrl}/rename`, {
        name: 'Brightmoor',
        reason: 'offensive name',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await heroRow(t.hero.id)).name).toBe('Brightmoor');
      expect((await lastAudit(t.acc.id, 'admin.hero.rename'))!.data).toMatchObject({
        before: { name: t.hero.name },
        after: { name: 'Brightmoor' },
      });
    });

    it('toggles a world flag only with the typed flag id, audited on the admin', async () => {
      const wrong = await admin('POST', '/api/admin/world/flags/ashenPassCleared', {
        set: true,
        confirm: 'ashen',
        reason: 'test the pass',
      });
      expect(wrong.json().error.code).toBe('confirmation_mismatch');
      const on = await admin('POST', '/api/admin/world/flags/ashenPassCleared', {
        set: true,
        confirm: 'ashenPassCleared',
        reason: 'test the pass',
      });
      expect(on.json()).toMatchObject({ before: false, after: true });
      const world = await admin('GET', '/api/admin/world');
      expect(world.json().flags.find((f: { id: string }) => f.id === 'ashenPassCleared').set).toBe(
        true,
      );
      // Ticket 6.6 added the event jobs.
      expect(world.json().scheduler.jobs).toHaveLength(6);
      // Ticket 6.3: this week's and next week's boss modifier.
      const mods = world.json().bossModifiers;
      expect(mods.current.modifier.id).toBe(bossModifierOfWeek(clockMs).id);
      expect(mods.next.week.startsAt).toBe(mods.current.week.endsAt);
      expect(mods.next.modifier.id).not.toBe(mods.current.modifier.id);
      const off = await admin('POST', '/api/admin/world/flags/ashenPassCleared', {
        set: false,
        confirm: 'ashenPassCleared',
        reason: 'back',
      });
      expect(off.json()).toMatchObject({ before: true, after: false });
      expect(await lastAudit(who.admin.id, 'admin.world.flag')).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('test accounts', () => {
    it('are left off the boards and the season archive (so its awards)', async () => {
      const deps = snapshotDeps(app);
      const start = new Date(clockMs + DAY);
      await scheduleSeason(
        db(),
        { startsAt: start, endsAt: new Date(start.getTime() + 14 * DAY) },
        now(),
        { accountId: null, via: 'cli' },
      );
      const real = await target({ level: 30 });
      const fake = await target({ test: true, level: 40 });
      clockMs = start.getTime() + DAY;
      for (const h of [real.hero, fake.hero]) {
        await db()
          .update(characters)
          .set({ level: h.level + 1 })
          .where(eq(characters.id, h.id));
        await refreshHeroScores(deps, h.id, now());
      }
      const board = await call(real.acc, 'GET', '/api/leaderboards/level?limit=100');
      expect(board.statusCode, board.body).toBe(200);
      const names = (board.json().board.entries as { player: { handle: string } }[]).map(
        (e) => e.player.handle,
      );
      expect(names).toContain(real.acc.handle);
      expect(names).not.toContain(fake.acc.handle);
      const own = await call(fake.acc, 'GET', '/api/leaderboards/level?limit=100');
      expect(own.json().board.yours).toEqual([]);
      clockMs = start.getTime() + 14 * DAY + SEASON_CLOSE_GRACE_MS + 1000;
      expect(await archiveSeason(db(), 1, now(), now())).toBe('archived');
      const standings = await db().select().from(seasonStandings);
      expect(standings.some((s) => s.accountId === real.acc.id)).toBe(true);
      expect(standings.some((s) => s.accountId === fake.acc.id)).toBe(false);
    });

    it('are never offered in matchmaking to players (and see only each other)', async () => {
      const seeker = await target({ level: 20 });
      const fake = await target({ test: true, level: 20 });
      const real = await target({ level: 20 });
      for (const t of [fake, real]) {
        const r = await call(t.acc, 'POST', '/api/arena/defence', { characterId: t.hero.id });
        expect(r.statusCode, r.body).toBeLessThan(300);
      }
      const defences = await db().select().from(duelDefences);
      const bracketId = defences.find((d) => d.characterId === real.hero.id)!.bracketId;
      const snapshot = defences.find((d) => d.characterId === real.hero.id)!.snapshot;
      const offered = async (accountId: string, heroId: string) => {
        const draw = await drawOpponents(
          db(),
          accountId,
          { characterId: heroId, snapshot },
          bracketId,
          now(),
          now(),
          'seed',
        );
        const ids = draw.defenceIds;
        return defences.filter((d) => ids.includes(d.id)).map((d) => d.accountId);
      };
      const forPlayer = await offered(seeker.acc.id, seeker.hero.id);
      expect(forPlayer).not.toContain(fake.acc.id);
      const other = await target({ test: true, level: 20 });
      const forTest = await offered(other.acc.id, other.hero.id);
      expect(forTest).not.toContain(real.acc.id);
    });

    it('can’t trade (a standing check of their own)', async () => {
      const t = await insertTrader(db(), now());
      await setTestAccount(db(), t.handle, true);
      const standing = await loadTradeStanding(db(), t.id, now());
      expect(standing!.testAccount).toBe(true);
      const b = await insertTrader(db(), now());
      await befriendSince(db(), t, b, now());
      const item = await insertTradeItem(db(), t.hero.id);
      const res = await tradeCalls(app).send({ ...t }, b, { give: { itemIds: [item.id] } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('trade_refused');
      expect(JSON.stringify(res.json())).toContain('test_account');
    });

    it('their telemetry goes to its own table: out of the report, in the reconciliation', async () => {
      const t = await target({ test: true });
      const own = await target();
      const sumGold = async (
        table: typeof telemetryDaily | typeof telemetryDailyTest,
        source: string,
      ) =>
        Number(
          (
            await db()
              .select({ n: sql<string>`coalesce(sum(amount), 0)` })
              .from(table)
              .where(and(eq(table.metric, 'gold.in'), eq(table.dim1, source)))
          )[0]!.n,
        );
      const beforeTest = await sumGold(telemetryDailyTest, 'admin_grant');
      const beforeReal = await sumGold(telemetryDaily, 'admin_refund');
      await admin('POST', `${t.heroUrl}/gold`, { mode: 'grant', amount: 777, reason: 'test gold' });
      await admin('POST', `${own.heroUrl}/gold`, { mode: 'refund', amount: 55, reason: 'refund' });
      expect((await sumGold(telemetryDailyTest, 'admin_grant')) - beforeTest).toBe(777);
      expect((await sumGold(telemetryDaily, 'admin_refund')) - beforeReal).toBe(55);
      const report = await loadRollups(db(), { from: null, to: null });
      expect(
        report.rows.some(
          (r) => r.metric === 'gold.in' && r.dims[0] === 'admin_grant' && r.amount >= 777,
        ),
      ).toBe(false);
      expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('hero deletion: soft delete → restore → purge', () => {
    it('hides and freezes the hero, voids offers, returns escrow, rehomes shelf items, withdraws the defence, drops board rows', async () => {
      const a = await insertTrader(db(), now());
      const b = await insertTrader(db(), now());
      await befriendSince(db(), a, b, now());
      const heir = await insertCharacter(db(), a.id, { level: 5 });
      // An offer from the doomed hero with an item in escrow, a shelf item it placed, a defence.
      const escrowed = await insertTradeItem(db(), a.hero.id);
      const sent = await tradeCalls(app).send(a, b, {
        give: { itemIds: [escrowed.id], gold: 100 },
      });
      expect(sent.statusCode, sent.body).toBe(201);
      const shelved = await insertItem(db(), a.hero.id, { rarityId: 'epic' });
      expect(
        (await shelfCalls(app).move(a.token, a.hero.id, 'deposit', { itemIds: [shelved.id] }))
          .statusCode,
      ).toBe(200);
      expect(
        (await call(a, 'POST', '/api/arena/defence', { characterId: a.hero.id })).statusCode,
      ).toBeLessThan(300);
      await refreshHeroScores(snapshotDeps(app), a.hero.id, now());
      expect(
        await db()
          .select()
          .from(leaderboardEntries)
          .where(eq(leaderboardEntries.characterId, a.hero.id)),
      ).not.toEqual([]);
      const url = `/api/admin/accounts/${a.handle}/heroes/${a.hero.id}`;

      const typo = await admin('POST', `${url}/delete`, {
        confirm: 'nope',
        reason: 'player asked',
      });
      expect(typo.json().error.code).toBe('confirmation_mismatch');
      const res = await admin('POST', `${url}/delete`, {
        confirm: a.hero.name.toUpperCase(),
        reason: 'player asked',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().deleted).toMatchObject({
        offersVoided: 1,
        shelfItemsRehomed: 1,
        leaderboardRowsRemoved: 4,
        defence: true,
      });

      // Hidden from the player and frozen.
      const list = await call(a, 'GET', '/api/characters');
      expect(list.json().characters.map((c: { id: string }) => c.id)).toEqual([heir.id]);
      expect((await call(a, 'POST', `/api/characters/${a.hero.id}/select`, {})).statusCode).toBe(
        404,
      );
      expect((await call(a, 'GET', `/api/characters/${a.hero.id}/inventory`)).statusCode).toBe(404);
      // Escrow returned, the offer voided, the shelf item now the heir's (still on the shelf).
      const [offer] = await db()
        .select()
        .from(tradeOffers)
        .where(eq(tradeOffers.id, sent.json().id));
      expect(offer!.status).toBe('void');
      const [esc] = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.id, escrowed.id));
      expect(esc!.escrowOfferId).toBeNull();
      const [sh] = await db().select().from(itemInstances).where(eq(itemInstances.id, shelved.id));
      expect(sh).toMatchObject({ characterId: heir.id, onShelf: true });
      expect(
        await db().select().from(duelDefences).where(eq(duelDefences.characterId, a.hero.id)),
      ).toEqual([]);
      expect(
        await db()
          .select()
          .from(leaderboardEntries)
          .where(eq(leaderboardEntries.characterId, a.hero.id)),
      ).toEqual([]);
      // The sweep never writes rows for it again.
      expect(await refreshHeroScores(snapshotDeps(app), a.hero.id, now())).toBe('missing');
      // A second delete: no live hero by that id.
      expect(
        (await admin('POST', `${url}/delete`, { confirm: a.hero.name, reason: 'again' }))
          .statusCode,
      ).toBe(404);
      expect((await lastAudit(a.id, 'admin.hero.delete'))!.data).toMatchObject({
        by: who.admin.id,
        offersVoided: 1,
        shelfItemsRehomed: 1,
      });
      expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);

      // Restore: back, with its defence; offers and the shelf item stay where they went.
      const back = await admin('POST', `${url}/restore`, { reason: 'mistake' });
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json().restored).toMatchObject({
        defenceRestored: true,
        notRestored: { offersVoided: 1, shelfItemsRehomed: 1 },
      });
      expect((await call(a, 'GET', '/api/characters')).json().characters).toHaveLength(2);
      expect(
        await db().select().from(duelDefences).where(eq(duelDefences.characterId, a.hero.id)),
      ).toHaveLength(1);
      expect(
        await db()
          .select()
          .from(leaderboardEntries)
          .where(eq(leaderboardEntries.characterId, a.hero.id)),
      ).toHaveLength(4);
      expect((await call(a, 'GET', `/api/characters/${a.hero.id}/inventory`)).statusCode).toBe(200);
    });

    it('refuses to delete a hero whose shelf items would have no other hero; refuses a restore past the window or without a free slot', async () => {
      const t = await target();
      const item = await insertItem(db(), t.hero.id, { rarityId: 'epic' });
      expect(
        (await shelfCalls(app).move(t.acc.token, t.hero.id, 'deposit', { itemIds: [item.id] }))
          .statusCode,
      ).toBe(200);
      const res = await admin('POST', `${t.heroUrl}/delete`, {
        confirm: t.hero.name,
        reason: 'asked',
      });
      expect(res.json().error.code).toBe('shelf_not_empty');
      expect((await heroRow(t.hero.id)).deletedAt).toBeNull();

      const u = await target();
      expect(
        (await admin('POST', `${u.heroUrl}/delete`, { confirm: u.hero.name, reason: 'asked' }))
          .statusCode,
      ).toBe(200);
      // Both slots used by new heroes: no room to restore.
      await insertCharacter(db(), u.acc.id);
      await insertCharacter(db(), u.acc.id);
      const full = await admin('POST', `${u.heroUrl}/restore`, { reason: 'asked' });
      expect(full.json().error.code).toBe('no_free_slot');
      const saved = clockMs;
      clockMs += RESTORE_WINDOW_MS + 1000;
      const late = await admin('POST', `${u.heroUrl}/restore`, { reason: 'asked' });
      expect(late.json().error.code).toBe('restore_window_passed');
      clockMs = saved;
    });

    it('the purge deletes heroes past the window, keeps heroes named in trade history', async () => {
      const t = await target();
      const traded = await target();
      await fakeAcceptedOffer(traded.acc.id, traded.hero.id);
      for (const x of [t, traded]) {
        expect(
          (await admin('POST', `${x.heroUrl}/delete`, { confirm: x.hero.name, reason: 'asked' }))
            .statusCode,
        ).toBe(200);
      }
      const early = await purgeDeletedHeroes(db(), now(), activity);
      expect(early.purged.map((p) => p.characterId)).not.toContain(t.hero.id);
      const later = new Date(clockMs + RESTORE_WINDOW_MS + 1000);
      const dry = await purgeDeletedHeroes(db(), later, activity, { dryRun: true });
      expect(dry.purged.map((p) => p.characterId)).toContain(t.hero.id);
      expect(await db().select().from(characters).where(eq(characters.id, t.hero.id))).toHaveLength(
        1,
      );
      const out = await purgeDeletedHeroes(db(), later, activity);
      expect(out.purged.map((p) => p.characterId)).toContain(t.hero.id);
      expect(out.kept.map((p) => p.characterId)).toContain(traded.hero.id);
      expect(await db().select().from(characters).where(eq(characters.id, t.hero.id))).toEqual([]);
      expect((await heroRow(traded.hero.id)).deletedAt).not.toBeNull();
      expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('the inspector and view as player', () => {
    it('shows the account file and a read-only hero view; never an email or password data', async () => {
      const t = await target({ test: true });
      await insertItem(db(), t.hero.id);
      const res = await admin('GET', t.base);
      expect(res.statusCode, res.body).toBe(200);
      const file = res.json().account;
      expect(file).toMatchObject({
        handle: t.acc.handle,
        testAccount: true,
        emailVerified: false,
        sessions: 1,
      });
      expect(file.heroes[0].items).toHaveLength(1);
      const before = await heroRow(t.hero.id);
      const view = await admin('GET', `${t.heroUrl}/view`);
      expect(view.statusCode).toBe(200);
      expect(view.json().readOnly).toBe(true);
      expect(await heroRow(t.hero.id)).toEqual(before);
    });

    it('guard: no admin answer in this file held an email, a password hash or a session token', async () => {
      // Its own calls (whatever ran before), then every admin answer this file saw.
      const t = await target({ test: true });
      await insertItem(db(), t.hero.id);
      for (const path of [t.base, `${t.heroUrl}/view`, '/api/admin/world']) {
        expect((await admin('GET', path)).statusCode).toBe(200);
      }
      await admin('POST', `${t.heroUrl}/gold`, { mode: 'grant', amount: 5, reason: 'guard run' });
      await admin('POST', `${t.base}/login-lock/clear`, { reason: 'guard run' });
      const emails = await db()
        .select({ e: accounts.email, h: accounts.passwordHash })
        .from(accounts);
      expect(seen.length).toBeGreaterThanOrEqual(5);
      for (const body of seen) {
        expect(body).not.toMatch(/@graumark\.test/);
        expect(body).not.toContain('not-a-real-hash');
        expect(body).not.toMatch(/passwordHash|password_hash|seedSecret|forgeSecret/);
        for (const { e } of emails) expect(body.includes(e)).toBe(false);
      }
    });
  });
});

describe('guard: soft-deleted heroes are hidden on every hero read', () => {
  /**
   * Every `.from(characters)` in server code must filter `deletedAt` within its statement, unless
   * the file is listed here with the reason it may see deleted heroes.
   */
  const ALLOWED: Record<string, string> = {
    'admin/inspector.ts': 'the admin inspector lists deleted heroes on purpose',
    'admin/tool-routes.ts': 'the admin view-as and deleted counts read by id or count deleted',
    'admin/heroes.ts': 'deletion, restore and purge',
    'admin/players.ts': 'D.3 lookup lists every hero',
    'admin/purge-hint.ts': 'counts deleted heroes',
    'activity/settle.ts':
      'by id under lockOwnedCharacter or the scheduler (a deleted hero has no activity)',
    'economy/shared.ts': 're-read by id after a refused update',
    'social/targets.ts': 'moderation targets keep history',
    'trading/offers.ts': 'offer views name the heroes of past offers',
    'trading/reversal.ts': 'moderator reversal views of past trades',
    'shelf/routes.ts': 'names of every hero that placed a shelf item',
    'inventory/binding-backfill.ts': 'data backfill over every row',
    'achievements/backfill.ts': 'data backfill over every row',
    'cosmetics/backfill.ts': 'data backfill over every row (6.8: as the achievements)',
    'leaderboards/snapshot.ts': 'checks deletedAt on the row it read',
    'names/checks.ts': 'hero names stay unique across deleted heroes (6.9: look-alikes too)',
  };
  it('every other hero read filters `deletedAt`', () => {
    const root = join(__dirname, '..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return f === 'test' || f === 'e2e' ? [] : files(p);
        return p.endsWith('.ts') && !p.endsWith('.test.ts') && !/simulate/.test(p) ? [p] : [];
      });
    const offenders: string[] = [];
    for (const p of files(root)) {
      const rel = relative(root, p);
      if (ALLOWED[rel]) continue;
      const lines = readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('.from(characters)')) return;
        const statement = lines.slice(Math.max(0, i - 6), i + 10).join('\n');
        if (!/deletedAt|deleted_at/.test(statement)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
