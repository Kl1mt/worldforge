/**
 * Ticket D.4b: the admin progress tools (set progress, set level, grant XP, grant an item) run the
 * gameplay paths' achievement and milestone refresh in their own transaction, so a cosmetic the new
 * state earns arrives at once, exactly once (a repeat or a double submit adds nothing), with its
 * normal source and `cosmetic.grant` audit row, and the tool's `admin.*` row names what it
 * triggered. The test-account gate still holds, removals take nothing back, and the telemetry
 * reconciliation still balances.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accountAchievements, auditLog, cosmeticUnlocks } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { insertCharacter } from '../test/heroes.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { setTestAccount } from './test-accounts.js';

// The injected clock, derived from the wall clock (CLAUDE.md "Dates").
let clockMs = Date.now();
const now = () => new Date(clockMs);
const activity = { ...DEFAULT_ACTIVITY_OPTIONS, now };

describe('admin progress tools grant cosmetics at once (D.4b)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  const db = () => database.db;
  let adminAcc: TestAccount;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
      },
      activity,
    });
    await app.ready();
    adminAcc = await insertAccount(db(), { role: 'admin', name: 'Castellan Orla', now: now() });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const post = (url: string, payload: object, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'idempotency-key': key },
      cookies: { [SESSION_COOKIE]: adminAcc.token },
    });

  async function target({ test = true, level = 10 } = {}) {
    const acc = await insertAccount(db(), { now: now() });
    if (test) await setTestAccount(db(), acc.handle, true);
    const hero = await insertCharacter(db(), acc.id, { level });
    return { acc, hero, heroUrl: `/api/admin/accounts/${acc.handle}/heroes/${hero.id}` };
  }
  const unlocks = async (accountId: string) =>
    (
      await db()
        .select({ id: cosmeticUnlocks.cosmeticId, source: cosmeticUnlocks.source })
        .from(cosmeticUnlocks)
        .where(eq(cosmeticUnlocks.accountId, accountId))
    ).sort((a, b) => a.id.localeCompare(b.id));
  const grantAudits = async (accountId: string) =>
    (
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'cosmetic.grant')))
    ).map((r) => (r.data as { cosmeticId: string }).cosmeticId);
  const lastAudit = async (accountId: string, event: string) =>
    (
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, event)))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(1)
    )[0]!;
  const ok = (res: LightMyRequestResponse) => {
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const progress = (extra: object) => ({
    gravewardenDefeated: false,
    cryptTierCleared: 0,
    ashenWardenDefeated: false,
    reason: 'testing milestones',
    ...extra,
  });

  it('marking each boss defeated grants its cosmetic at once, exactly once, with its normal source', async () => {
    const t = await target({ level: 36 });
    const milestone = `milestone:${t.hero.id}`;
    // The Gravewarden: a deed (achievement), so its cosmetic comes with the award.
    const grave = ok(await post(`${t.heroUrl}/progress`, progress({ gravewardenDefeated: true })));
    expect(grave.earned.cosmetics).toEqual(['appearance.grave-moss']);
    expect(grave.earned.achievements).toContain('gravewardenSlain');
    // The Ashen Warden and the Forge Tyrant: milestones from the hero's row.
    const bosses = ok(
      await post(
        `${t.heroUrl}/progress`,
        progress({
          gravewardenDefeated: true,
          ashenWardenDefeated: true,
          forgeTyrantDefeated: true,
        }),
      ),
    );
    expect([...bosses.earned.cosmetics].sort()).toEqual([
      'appearance.ember',
      'banner.warden-flame',
    ]);
    expect(await unlocks(t.acc.id)).toEqual([
      { id: 'appearance.ember', source: milestone },
      { id: 'appearance.grave-moss', source: 'achievement:gravewardenSlain' },
      { id: 'banner.warden-flame', source: milestone },
    ]);
    // The admin row records that this action triggered them.
    expect((await lastAudit(t.acc.id, 'admin.progress')).data).toMatchObject({
      by: adminAcc.id,
      earned: { cosmetics: expect.arrayContaining(['appearance.ember', 'banner.warden-flame']) },
    });
    // The same write again: nothing new.
    const again = ok(
      await post(
        `${t.heroUrl}/progress`,
        progress({
          gravewardenDefeated: true,
          ashenWardenDefeated: true,
          forgeTyrantDefeated: true,
        }),
      ),
    );
    expect(again.earned).toEqual({ achievements: [], cosmetics: [] });
    expect((await grantAudits(t.acc.id)).sort()).toEqual([
      'appearance.ember',
      'appearance.grave-moss',
      'banner.warden-flame',
    ]);
  });

  it('crypt tier III and IV grant the crypt seal and the Heroic look', async () => {
    const t = await target({ level: 34 });
    const tier3 = ok(
      await post(
        `${t.heroUrl}/progress`,
        progress({ gravewardenDefeated: true, cryptTierCleared: 3 }),
      ),
    );
    expect(tier3.earned.cosmetics).toContain('banner.crypt-seal');
    expect(tier3.earned.cosmetics).not.toContain('appearance.midnight');
    const tier4 = ok(
      await post(
        `${t.heroUrl}/progress`,
        progress({ gravewardenDefeated: true, cryptTierCleared: 4 }),
      ),
    );
    expect(tier4.earned.cosmetics).toEqual(['appearance.midnight']);
    expect((await unlocks(t.acc.id)).map((u) => u.id)).toEqual(
      expect.arrayContaining(['appearance.midnight', 'banner.crypt-seal']),
    );
  });

  it('setting the level to 40 grants the Ashen look; a double submit with one key grants it once', async () => {
    const t = await target({ level: 20 });
    const key = randomUUID();
    const body = { level: 40, reason: 'testing level 40' };
    // Raced with the same key: whichever runs first, the other replays its answer.
    const [a, b] = await Promise.all([
      post(`${t.heroUrl}/level`, body, key),
      post(`${t.heroUrl}/level`, body, key),
    ]);
    expect(ok(a).earned.cosmetics).toEqual(['appearance.ashen']);
    expect(ok(b)).toEqual(ok(a));
    expect(await unlocks(t.acc.id)).toEqual([
      { id: 'appearance.ashen', source: `milestone:${t.hero.id}` },
    ]);
    expect(await grantAudits(t.acc.id)).toEqual(['appearance.ashen']);
    // A new key: the level is set again, nothing more is granted.
    expect(ok(await post(`${t.heroUrl}/level`, body)).earned.cosmetics).toEqual([]);
    expect(await grantAudits(t.acc.id)).toEqual(['appearance.ashen']);
    // Lowering the level takes nothing back (6.8).
    ok(await post(`${t.heroUrl}/level`, { level: 5, reason: 'back down' }));
    expect((await unlocks(t.acc.id)).map((u) => u.id)).toEqual(['appearance.ashen']);
  });

  it('XP that lifts a hero to 40 grants the Ashen look through the normal level-up', async () => {
    const t = await target({ level: 39 });
    const res = ok(await post(`${t.heroUrl}/xp`, { xp: 50_000_000, reason: 'to the cap' }));
    expect(res.after.level).toBeGreaterThanOrEqual(40);
    expect(res.earned.cosmetics).toEqual(['appearance.ashen']);
    expect((await lastAudit(t.acc.id, 'admin.xp')).data).toMatchObject({
      earned: { cosmetics: ['appearance.ashen'] },
    });
  });

  it('a granted +10 Legendary is a deed like a found one', async () => {
    const t = await target({ level: 38 });
    const spec = {
      baseId: 'longsword',
      rarityId: 'legendary',
      itemLevel: 37,
      variant: null,
      upgradeLevel: 10,
    };
    const pre = ok(
      await app.inject({
        method: 'POST',
        url: `${t.heroUrl}/items/preview`,
        payload: spec,
        headers: { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: adminAcc.token },
      }),
    );
    const res = ok(
      await post(`${t.heroUrl}/items/grant`, { ...spec, seed: pre.seed, reason: 'deed testing' }),
    );
    expect([...res.earned.cosmetics].sort()).toEqual(['crest.ember', 'title-colour.ember']);
    const achievements = await db()
      .select({ id: accountAchievements.achievementId })
      .from(accountAchievements)
      .where(eq(accountAchievements.accountId, t.acc.id));
    expect(achievements.map((a) => a.id)).toEqual(
      expect.arrayContaining(['firstLegendary', 'forgePlus10']),
    );
  });

  it('clearing a boss flag takes nothing back', async () => {
    const t = await target({ level: 36 });
    ok(
      await post(
        `${t.heroUrl}/progress`,
        progress({ gravewardenDefeated: true, ashenWardenDefeated: true }),
      ),
    );
    const before = await unlocks(t.acc.id);
    expect(before.map((u) => u.id)).toEqual(['appearance.grave-moss', 'banner.warden-flame']);
    const cleared = ok(await post(`${t.heroUrl}/progress`, progress({})));
    expect(cleared.earned).toEqual({ achievements: [], cosmetics: [] });
    expect(await unlocks(t.acc.id)).toEqual(before);
  });

  it('still refuses a normal account, and grants nothing there', async () => {
    const t = await target({ test: false, level: 36 });
    const refused = await post(
      `${t.heroUrl}/progress`,
      progress({ gravewardenDefeated: true, ashenWardenDefeated: true, forgeTyrantDefeated: true }),
    );
    expect(refused.json().error.code).toBe('test_account_required');
    const level = await post(`${t.heroUrl}/level`, { level: 40, reason: 'not here' });
    expect(level.json().error.code).toBe('test_account_required');
    expect(await unlocks(t.acc.id)).toEqual([]);
    expect(await grantAudits(t.acc.id)).toEqual([]);
  });

  it('works on the admin’s own account, and the reconciliation still balances', async () => {
    const hero = await insertCharacter(db(), adminAcc.id, { level: 30 });
    const res = ok(
      await post(`/api/admin/accounts/${adminAcc.handle}/heroes/${hero.id}/level`, {
        level: 40,
        reason: 'own account',
      }),
    );
    expect(res.warning).toBe('public_boards');
    expect(res.earned.cosmetics).toEqual(['appearance.ashen']);
    clockMs += 1000;
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });
});
