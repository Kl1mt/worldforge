import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  SHRINE_BANK_LIMIT,
  SHRINE_DUPLICATE_MARKS,
  SHRINE_MARK_PRICES,
  SHRINE_POOL,
  drawShrine,
  shrineOdds,
  type ShrineRarity,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  auditLog,
  cosmeticUnlocks,
  shrineDrawGrants,
  shrineDraws,
  telemetryDaily,
  telemetryDailyTest,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../idempotency/index.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { awardAchievements } from '../achievements/award.js';
import { drawTx, grantPlayDrawsTx, reconcileShrine } from './model.js';
import type { ShrineView } from './routes.js';

/**
 * Ticket 9.5: the Reward Shrine on the server (docs/SHRINE.md). Draw outcomes depend on `crypto`
 * seeds, so no test asserts what an unpinned draw drew: it predicts it from the stored seed with
 * game-core, or pins the seed (`drawTx`'s seed parameter, found by searching game-core's own rule).
 * The clock is injected and derived from the wall clock; every account's `created_at` is set from
 * it (CLAUDE.md "Dates").
 */

const DAY = 86_400_000;
/** Noon UTC today (wall clock), so a step of hours never crosses a day by accident. */
const START = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
let clockMs = START;
const now = () => new Date(clockMs);

let database: DatabaseHandle;
let app: FastifyInstance;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: {
      now,
      accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
      socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] },
    },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

/** An account made `ageDays` before the clock (0 = today). */
async function account(ageDays: number, opts: { test?: boolean } = {}): Promise<TestAccount> {
  const a = await insertAccount(db(), { now: now() });
  await db()
    .update(accounts)
    .set({ createdAt: new Date(clockMs - ageDays * DAY), isTest: opts.test ?? false })
    .where(eq(accounts.id, a.id));
  return a;
}

const get = (a: TestAccount) =>
  app.inject({ method: 'GET', url: '/api/account/shrine', cookies: { wf_session: a.token } });
const post = (a: TestAccount, url: string, payload?: object, key: string | null = randomUUID()) =>
  app.inject({
    method: 'POST',
    url,
    ...(payload ? { payload } : {}),
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { wf_session: a.token },
  });
const view = async (a: TestAccount) => {
  const res = await get(a);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ShrineView>();
};

/** A seed that draws `cosmeticId` (searched with game-core's own rule). */
function seedFor(cosmeticId: string): string {
  for (let i = 0; i < 100_000; i++) {
    const seed = `pinned-${cosmeticId}-${i}`;
    if (drawShrine(seed).cosmeticId === cosmeticId) return seed;
  }
  throw new Error(`no seed draws ${cosmeticId}`);
}

const firstOf = (r: ShrineRarity) => SHRINE_POOL.find((e) => e.rarity === r)!.cosmeticId;

describe('the published odds', () => {
  it('docs/SHRINE.md lists exactly game-core’s odds', () => {
    const doc = readFileSync(join(import.meta.dirname, '../../../../docs/SHRINE.md'), 'utf8');
    const rows = [
      ...doc.matchAll(/^\| `([a-z-]+\.[a-z0-9-]+)` \| [^|]+ \| (\w+) \| (\w+) \| ([\d.]+) % \|$/gm),
    ];
    const published = rows.map((m) => ({ id: m[1], kind: m[2], rarity: m[3], pct: m[4] }));
    expect(published).toEqual(
      shrineOdds().map((o) => ({
        id: o.cosmeticId,
        kind: SHRINE_POOL.find((e) => e.cosmeticId === o.cosmeticId)!.kind,
        rarity: o.rarity,
        pct: (o.chance * 100).toFixed(3),
      })),
    );
    // The rarity table too.
    for (const r of ['common', 'rare', 'hallowed'] as const) {
      const m = doc.match(new RegExp(`^\\| ${r} \\| (\\d+) % \\| (\\d+) \\| (\\d+) \\|$`, 'm'));
      expect(m, r).not.toBeNull();
      const chance = shrineOdds()
        .filter((o) => o.rarity === r)
        .reduce((a, o) => a + o.chance, 0);
      expect(Number(m![1])).toBeCloseTo(chance * 100, 9);
      expect(Number(m![2])).toBe(SHRINE_DUPLICATE_MARKS[r]);
      expect(Number(m![3])).toBe(SHRINE_MARK_PRICES[r]);
    }
  });

  it('the Shrine serves the same odds and sells no draw', async () => {
    const a = await account(0);
    const v = await view(a);
    expect(v.paidDraws).toBe(false);
    expect(v.pool.map((p) => [p.cosmeticId, p.chance])).toEqual(
      shrineOdds().map((o) => [o.cosmeticId, o.chance]),
    );
    // Nothing the shop route takes is a draw.
    const res = await post(a, '/api/account/shrine/buy', { cosmeticId: 'draw' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('unknown_offer');
  });
});

describe('the free-draw bank', () => {
  it('a new account holds today’s draw; an old one a full bank', async () => {
    clockMs = START;
    expect((await view(await account(0))).unspent).toEqual({ daily: 1, play: 0, shop: 0 });
    expect((await view(await account(1))).unspent.daily).toBe(2);
    expect((await view(await account(400))).unspent.daily).toBe(SHRINE_BANK_LIMIT);
  });

  it('adds one a day up to the limit and never pays back days a full bank sat through', async () => {
    clockMs = START;
    const a = await account(30);
    expect((await view(a)).unspent.daily).toBe(7);
    for (let i = 0; i < 2; i++)
      expect((await post(a, '/api/account/shrine/draw')).statusCode).toBe(200);
    expect((await view(a)).unspent.daily).toBe(5);
    // The day boundary: 1 ms before midnight adds nothing, midnight adds one.
    const midnight = (Math.floor(START / DAY) + 1) * DAY;
    clockMs = midnight - 1;
    expect((await view(a)).unspent.daily).toBe(5);
    clockMs = midnight;
    const at = await view(a);
    expect(at.unspent.daily).toBe(6);
    expect(at.nextFreeAt).toBe(new Date(midnight + DAY).toISOString());
    clockMs = midnight + DAY;
    expect((await view(a)).unspent.daily).toBe(7);
    expect((await view(a)).nextFreeAt).toBeNull();
    clockMs = midnight + 2 * DAY;
    expect((await view(a)).unspent.daily).toBe(7);
    // Twenty days later, all seven drawn: nothing is paid back for the days it sat full.
    clockMs = midnight + 22 * DAY;
    for (let i = 0; i < 7; i++)
      expect((await post(a, '/api/account/shrine/draw')).statusCode).toBe(200);
    expect((await view(a)).unspent.daily).toBe(0);
    const empty = await post(a, '/api/account/shrine/draw');
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error.code).toBe('no_draws');
    clockMs = midnight + 23 * DAY;
    expect((await view(a)).unspent.daily).toBe(1);
    // A clock that goes back adds nothing.
    clockMs = midnight + 10 * DAY;
    expect((await view(a)).unspent.daily).toBe(1);
    expect((await reconcileShrine(db(), a.id)).ok).toBe(true);
    // One daily grant row per day it accrued, each audited.
    const grants = await db()
      .select()
      .from(shrineDrawGrants)
      .where(eq(shrineDrawGrants.accountId, a.id));
    expect(grants.reduce((n, g) => n + g.count, 0)).toBe(7 + 1 + 1 + 1);
    expect(new Set(grants.map((g) => g.sourceKey)).size).toBe(grants.length);
    clockMs = START;
  });
});

describe('drawing', () => {
  it('needs a key; a replayed key pays once; the stored seed replays the draw', async () => {
    clockMs = START;
    const a = await account(0);
    expect((await post(a, '/api/account/shrine/draw', undefined, null)).statusCode).toBe(400);
    const key = randomUUID();
    const first = await post(a, '/api/account/shrine/draw', undefined, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await post(a, '/api/account/shrine/draw', undefined, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    expect(again.json()).toEqual(first.json());
    const rows = await db().select().from(shrineDraws).where(eq(shrineDraws.accountId, a.id));
    expect(rows).toHaveLength(1);
    const d = first.json<{
      draw: { seed: string; cosmeticId: string; outcome: string; spentSource: string };
    }>().draw;
    expect(d.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(drawShrine(d.seed).cosmeticId).toBe(d.cosmeticId);
    expect(d.outcome).toBe('grant');
    expect(d.spentSource).toBe('daily');
    const [unlock] = await db()
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, a.id));
    expect(unlock).toMatchObject({
      cosmeticId: d.cosmeticId,
      source: `shrine:draw:${rows[0]!.id}`,
    });
    expect((await view(a)).draws).toBe(0);
  });

  it('spends free draws before play draws', async () => {
    const a = await account(0);
    await withTransaction(db(), (tx) =>
      grantPlayDrawsTx(tx, { accountId: a.id, key: 'achievement:test', count: 2, now: now() }),
    );
    expect((await view(a)).unspent).toEqual({ daily: 1, play: 2, shop: 0 });
    const spent = [];
    for (let i = 0; i < 3; i++) {
      spent.push((await post(a, '/api/account/shrine/draw')).json().draw.spentSource);
    }
    expect(spent).toEqual(['daily', 'play', 'play']);
  });

  it('a duplicate pays its marks, and marks buy a chosen keepsake', async () => {
    const a = await account(0);
    const common = firstOf('common');
    const rare = firstOf('rare');
    await withTransaction(db(), (tx) =>
      grantPlayDrawsTx(tx, { accountId: a.id, key: 'test:marks', count: 20, now: now() }),
    );
    const seed = seedFor(common);
    // The first pinned draw grants it; the next ones are duplicates.
    const out = [];
    for (let i = 0; i < 1 + 13; i++) {
      out.push(await withTransaction(db(), (tx) => drawTx(tx, a.id, now(), seed)));
    }
    expect(out[0]!.outcome).toBe('grant');
    expect(
      out.slice(1).every((o) => o.outcome === 'marks' && o.marks === SHRINE_DUPLICATE_MARKS.common),
    ).toBe(true);
    const marks = 13 * SHRINE_DUPLICATE_MARKS.common;
    expect((await view(a)).marks).toBe(marks);
    // The shop's refusals.
    const owned = await post(a, '/api/account/shrine/buy', { cosmeticId: common });
    expect([owned.statusCode, owned.json().error.code]).toEqual([409, 'already_owned']);
    const notShrine = await post(a, '/api/account/shrine/buy', { cosmeticId: 'banner.forgeward' });
    expect([notShrine.statusCode, notShrine.json().error.code]).toEqual([422, 'unknown_offer']);
    const hallowed = await post(a, '/api/account/shrine/buy', { cosmeticId: firstOf('hallowed') });
    expect([hallowed.statusCode, hallowed.json().error.code]).toEqual([422, 'insufficient_marks']);
    // A rare (25) from 26 marks; the replayed key pays once.
    const key = randomUUID();
    const bought = await post(a, '/api/account/shrine/buy', { cosmeticId: rare }, key);
    expect(bought.statusCode, bought.body).toBe(200);
    expect(bought.json().bought).toEqual({ cosmeticId: rare, price: SHRINE_MARK_PRICES.rare });
    const replay = await post(a, '/api/account/shrine/buy', { cosmeticId: rare }, key);
    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    const v = await view(a);
    expect(v.marks).toBe(marks - SHRINE_MARK_PRICES.rare);
    expect(v.pool.find((p) => p.cosmeticId === rare)!.owned).toBe(true);
    const unlocks = await db()
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, a.id));
    expect(unlocks.find((u) => u.cosmeticId === rare)!.source).toBe('shrine:marks');
    const r = await reconcileShrine(db(), a.id);
    expect(r).toMatchObject({
      ok: true,
      draws: 14,
      grants: 1,
      marksDraws: 13,
      marksEarned: marks,
      marksSpent: 25,
    });
  });

  it('a companion drawn can be worn beside the hero; one not owned cannot', async () => {
    const a = await account(0);
    const companion = SHRINE_POOL.find((e) => e.kind === 'companion')!.cosmeticId;
    const other = SHRINE_POOL.filter((e) => e.kind === 'companion')[1]!.cosmeticId;
    await withTransaction(db(), (tx) =>
      grantPlayDrawsTx(tx, { accountId: a.id, key: 'test:companion', count: 1, now: now() }),
    );
    await withTransaction(db(), (tx) => drawTx(tx, a.id, now(), seedFor(companion)));
    const worn = await post(a, '/api/account/cosmetics/equip', { companion });
    expect(worn.statusCode, worn.body).toBe(200);
    expect(worn.json().equipped.companion).toBe(companion);
    const refused = await post(a, '/api/account/cosmetics/equip', { companion: other });
    expect([refused.statusCode, refused.json().error.code]).toEqual([422, 'not_owned']);
    const wrong = await post(a, '/api/account/cosmetics/equip', { companion: 'banner.forgeward' });
    expect(wrong.json().error.code).toBe('wrong_kind');
    const off = await post(a, '/api/account/cosmetics/equip', { companion: null });
    expect(off.json().equipped.companion).toBeNull();
  });
});

describe('play draws', () => {
  it('a source pays its draws once', async () => {
    const a = await account(0);
    for (let i = 0; i < 3; i++) {
      await withTransaction(db(), (tx) =>
        grantPlayDrawsTx(tx, { accountId: a.id, key: 'event:7:tier:2', count: 1, now: now() }),
      );
    }
    expect((await view(a)).unspent.play).toBe(1);
    const audits = (await db().select().from(auditLog).where(eq(auditLog.accountId, a.id))).filter(
      (r) => r.event === 'shrine.grant' && (r.data as { source: string }).source === 'play',
    );
    expect(audits).toHaveLength(1);
  });

  it('a deed earned live pays a draw; the backfill pays none', async () => {
    const a = await account(0);
    const b = await account(0);
    const hero = await insertCharacter(db(), a.id, { level: 10 });
    const facts = { contractsTurnedIn: 10 };
    const live = await withTransaction(db(), (tx) =>
      awardAchievements(
        tx,
        { accountId: a.id, characterId: hero.id, now: now(), source: 'live' },
        facts,
      ),
    );
    expect(live).toContain('contracts10');
    const back = await withTransaction(db(), (tx) =>
      awardAchievements(
        tx,
        { accountId: b.id, characterId: null, now: now(), source: 'backfill' },
        facts,
      ),
    );
    expect(back).toContain('contracts10');
    const keys = async (id: string) =>
      (await db().select().from(shrineDrawGrants).where(eq(shrineDrawGrants.accountId, id)))
        .filter((g) => g.source === 'play')
        .map((g) => g.sourceKey);
    expect(await keys(a.id)).toEqual(live.map((id) => `achievement:${id}`));
    expect(await keys(b.id)).toEqual([]);
  });
});

describe('reconciliation and telemetry', () => {
  it('test accounts draw, but their draws never count in telemetry', async () => {
    const tester = await account(10, { test: true });
    const n = (await view(tester)).draws;
    for (let i = 0; i < n; i++)
      expect((await post(tester, '/api/account/shrine/draw')).statusCode).toBe(200);
    const live = await db().select().from(telemetryDaily);
    const test = await db().select().from(telemetryDailyTest);
    const drawsIn = (rows: typeof live) =>
      rows.filter((r) => r.metric === 'shrine.draw').reduce((a, r) => a + r.events, 0);
    const testerDraws = await db()
      .select()
      .from(shrineDraws)
      .where(eq(shrineDraws.accountId, tester.id));
    expect(testerDraws).toHaveLength(n);
    expect(drawsIn(test)).toBe(n);
    // Every live-table draw belongs to a player account.
    const all = await db().select().from(shrineDraws);
    expect(drawsIn(live)).toBe(all.length - n);
  });

  it('every account reconciles, and the rollups match the audit log', async () => {
    const all = await db().select({ id: accounts.id }).from(accounts);
    for (const { id } of all) {
      const r = await reconcileShrine(db(), id);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const bad = (await reconcileWithAudit(db())).filter((c) => !c.ok);
    expect(bad).toEqual([]);
  });
});
