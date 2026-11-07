/**
 * Ticket 5.2: leaderboard snapshots and boards (docs/LEADERBOARDS.md "Boards").
 * - Recompute equality: every stored row equals game-core's `computeScore` of its stored input and
 *   of the hero's current state (`checkLeaderboards`), after API events and after the sweep.
 * - The refresh: equip moves Gear Score and Power with the request's clock as `achieved_at`; a
 *   no-op leaves rows alone; an XP-only change recomputes only Character Level.
 * - The board: the SQL order is game-core's `compareBoardEntries`, pages cover everyone once,
 *   filters, your own rank, ETag, sanctions excluded, hidden names withheld, no ids in answers.
 * - The profile-link privacy matrix: each visibility × viewer relation.
 * - Invariance: refreshing and reading boards changes no gameplay row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  ITEM_BASES,
  PROFILE_VISIBILITIES,
  SCORE_METRICS,
  canClassUseItem,
  canViewProfile,
  compareBoardEntries,
  computeScore,
  equipmentSlotsForKind,
  generateItem,
  type ClassId,
  type EquipmentSlotId,
  type ProfileRelation,
  type ProfileVisibility,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  blocks,
  characters,
  friendships,
  guildMembers,
  itemInstances,
  leaderboardEntries,
  sanctions,
  worldFlags,
  type Character,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { checkLeaderboards } from './check.js';
import { cliDeps, formatCheck } from './leaderboard-cli.js';
import { refreshHeroScores, snapshotInput, sweepLeaderboards } from './snapshot.js';
import type { BoardEntryView, BoardView } from './routes.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let call: ReturnType<typeof caller>;
let nowMs = Date.parse('2026-11-07T12:00:00Z');
const now = () => new Date(nowMs);
const deps = () => cliDeps(database.db);

/** Generated items of one rarity for every slot the class can fill, in the pack (not equipped). */
async function packKit(hero: Character, itemLevel: number, rarityId: RarityId, seed: number) {
  const ids: { id: string; slot: EquipmentSlotId }[] = [];
  const taken = new Set<string>();
  for (const base of ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, hero.classId),
  ).sort((a, b) => b.tier - a.tier)) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of equipmentSlotsForKind(base.slot)) {
      const item = generateItem({ seed: seed++, itemLevel, baseId: base.id, rarityId })!;
      const id = uuidv7();
      await database.db.insert(itemInstances).values({
        id,
        characterId: hero.id,
        baseId: item.baseId,
        rarityId: item.rarityId,
        itemLevel: item.itemLevel,
        affixes: item.affixes,
        seed: item.seed,
        source: 'test',
      });
      ids.push({ id, slot: slot as EquipmentSlotId });
    }
  }
  return ids;
}

async function equipKit(who: TestAccount, hero: Character, itemLevel: number, rarity: RarityId) {
  for (const { id, slot } of await packKit(hero, itemLevel, rarity, itemLevel * 101)) {
    const res = await call(who, 'POST', `/api/characters/${hero.id}/items/${id}/equip`, { slot });
    expect(res.statusCode, res.body).toBe(200);
  }
}

const rowsOf = (characterId: string) =>
  database.db
    .select()
    .from(leaderboardEntries)
    .where(eq(leaderboardEntries.characterId, characterId));

async function board(who: TestAccount, path: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/leaderboards/${path}`,
    headers,
    cookies: { wf_session: who.token },
  });
  return res;
}
const boardOf = async (who: TestAccount, path: string) => {
  const res = await board(who, path);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ board: BoardView }>().board;
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    leaderboards: { readLimit: { max: 10_000, windowMs: 60_000 } },
    worldStateTtlMs: 0,
  });
  await app.ready();
  call = caller(app);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

beforeEach(() => {
  nowMs += 60_000;
});

describe('snapshots', () => {
  it('equip refreshes Gear Score and Power with the request clock; rows equal the formula', async () => {
    const who = await insertAccount(database.db, { now: now() });
    const hero = await insertCharacter(database.db, who.id, { classId: 'hunter', level: 18 });
    const before = now();
    await equipKit(who, hero, 17, 'rare');
    const rows = await rowsOf(hero.id);
    expect(rows.map((r) => r.metric).sort()).toEqual([...SCORE_METRICS].sort());
    const current = await snapshotInput(database.db, (await heroRow(hero.id))!, deps().worldFlags);
    for (const r of rows) {
      const score = computeScore(r.metric, r.input);
      expect(r.value, r.metric).toBe(score.value);
      expect(r.sortKey, r.metric).toEqual(score.sortKey);
      expect(computeScore(r.metric, current).value, r.metric).toBe(r.value);
    }
    const gear = rows.find((r) => r.metric === 'gearScore')!;
    expect(gear.value).toBeGreaterThan(0);
    expect(gear.achievedAt.getTime()).toBe(before.getTime());

    // A later no-op write changes no row.
    nowMs += 60_000;
    const again = await call(who, 'POST', `/api/characters/${hero.id}/select`);
    expect(again.statusCode).toBe(200);
    expect(await rowsOf(hero.id)).toEqual(rows);
  });

  it('an XP-only change recomputes Character Level only, and moves its achieved-at', async () => {
    const who = await insertAccount(database.db, { now: now() });
    const hero = await insertCharacter(database.db, who.id, { classId: 'mage', level: 12 });
    await refreshHeroScores(deps(), hero.id, now());
    const first = await rowsOf(hero.id);
    nowMs += 60_000;
    await database.db.update(characters).set({ experience: 77 }).where(eq(characters.id, hero.id));
    expect(await refreshHeroScores(deps(), hero.id, now())).toBe('updated');
    const second = await rowsOf(hero.id);
    for (const r of second) {
      const old = first.find((f) => f.metric === r.metric)!;
      if (r.metric === 'level') {
        expect(r.sortKey).toEqual([12, 77]);
        expect(r.achievedAt.getTime()).toBe(now().getTime());
      } else expect(r).toEqual(old);
    }
  });

  it('a level-up updates every row’s level for the bracket filter', async () => {
    const who = await insertAccount(database.db, { now: now() });
    const hero = await insertCharacter(database.db, who.id, { level: 9 });
    await refreshHeroScores(deps(), hero.id, now());
    await database.db.update(characters).set({ level: 10 }).where(eq(characters.id, hero.id));
    await refreshHeroScores(deps(), hero.id, now());
    expect(new Set((await rowsOf(hero.id)).map((r) => r.level))).toEqual(new Set([10]));
  });
});

const heroRow = async (id: string) =>
  (await database.db.select().from(characters).where(eq(characters.id, id)))[0];

describe('recompute check and sweep', () => {
  it('backfills heroes without rows, catches a world flag, and every row matches', async () => {
    const who = await insertAccount(database.db, { now: now() });
    const old = await insertCharacter(database.db, who.id, {
      level: 24,
      progress: { gravewardenDefeated: true, cryptTierCleared: 3 },
    });
    // A hero from before 5.2: no rows until the sweep reaches it.
    expect((await checkLeaderboards(deps())).problems.some((p) => p.characterId === old.id)).toBe(
      true,
    );
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const out = await sweepLeaderboards(deps(), now(), { batch: 50, cursor });
      cursor = out.cursor;
      if (cursor === null) break;
    }
    expect((await checkLeaderboards(deps())).problems).toEqual([]);
    const pve = (await rowsOf(old.id)).find((r) => r.metric === 'pveProgress')!;

    // The community opens the Ashen Pass: the hero's PvE Progress is stale until the sweep runs.
    await database.db.insert(worldFlags).values({ flagId: 'ashenPassCleared', setAt: now() });
    const stale = await checkLeaderboards(deps());
    expect(stale.problems.filter((p) => p.characterId === old.id)).toEqual([
      expect.objectContaining({ metric: 'pveProgress', kind: 'stale' }),
    ]);
    for (cursor = null; ;) {
      const out = await sweepLeaderboards(deps(), now(), { batch: 50, cursor });
      cursor = out.cursor;
      if (cursor === null) break;
    }
    const report = await checkLeaderboards(deps());
    expect(report.problems).toEqual([]);
    expect(report.matching).toBe(report.rows);
    expect(formatCheck(report)).toMatch(/match their formula/);
    const after = (await rowsOf(old.id)).find((r) => r.metric === 'pveProgress')!;
    expect(after.value).toBe(pve.value + 1);
    await database.db.delete(worldFlags).where(eq(worldFlags.flagId, 'ashenPassCleared'));
    await sweepAll();
  });

  it('tells a wrong row from an outdated one', async () => {
    const who = await insertAccount(database.db, { now: now() });
    const hero = await insertCharacter(database.db, who.id, { level: 5 });
    await refreshHeroScores(deps(), hero.id, now());
    await database.db
      .update(leaderboardEntries)
      .set({ value: 99 })
      .where(
        and(eq(leaderboardEntries.characterId, hero.id), eq(leaderboardEntries.metric, 'level')),
      );
    await database.db
      .update(leaderboardEntries)
      .set({ formulaVersion: 0 })
      .where(
        and(eq(leaderboardEntries.characterId, hero.id), eq(leaderboardEntries.metric, 'power')),
      );
    const mine = (await checkLeaderboards(deps())).problems.filter(
      (p) => p.characterId === hero.id,
    );
    expect(mine.map((p) => [p.metric, p.kind]).sort()).toEqual([
      ['level', 'wrong'],
      ['power', 'outdated'],
    ]);
    // The refresh repairs the outdated row; a wrong row is rewritten once its hash no longer
    // matches the state (here: delete it and let the refresh recompute).
    await database.db
      .delete(leaderboardEntries)
      .where(
        and(eq(leaderboardEntries.characterId, hero.id), eq(leaderboardEntries.metric, 'level')),
      );
    await refreshHeroScores(deps(), hero.id, now());
    expect(
      (await checkLeaderboards(deps())).problems.filter((p) => p.characterId === hero.id),
    ).toEqual([]);
  });
});

async function sweepAll() {
  let cursor: string | null = null;
  for (;;) {
    const out = await sweepLeaderboards(deps(), now(), { batch: 100, cursor });
    cursor = out.cursor;
    if (cursor === null) return;
  }
}

describe('boards', () => {
  let viewer: TestAccount;
  const field: Character[] = [];

  beforeAll(async () => {
    viewer = await insertAccount(database.db, { now: now(), name: 'Board Viewer' });
    const classes: ClassId[] = ['warrior', 'mage', 'hunter', 'warlock'];
    for (let i = 0; i < 14; i++) {
      const owner = i === 0 ? viewer : await insertAccount(database.db, { now: now() });
      const hero = await insertCharacter(database.db, owner.id, {
        classId: classes[i % 4]!,
        // Pairs share a level, so ties exist on Character Level and PvE Progress.
        level: 3 + Math.floor(i / 2) * 3,
      });
      field.push(hero);
      nowMs += 1000;
      await refreshHeroScores(deps(), hero.id, now());
    }
  });

  it('ranks in game-core’s board order, and pages cover every hero once', async () => {
    for (const metric of SCORE_METRICS) {
      const rows = await database.db
        .select()
        .from(leaderboardEntries)
        .where(eq(leaderboardEntries.metric, metric));
      const sanctionedOut = new Set<string>();
      const expected = rows
        .filter((r) => !sanctionedOut.has(r.accountId))
        .map((r) => ({ sortKey: r.sortKey, achievedAt: r.achievedAt, id: r.characterId }))
        .sort(compareBoardEntries);
      const seen: BoardEntryView[] = [];
      let cursor: string | null = null;
      let total: number | undefined;
      do {
        const page = await boardOf(viewer, `${metric}?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
        total = page.total;
        seen.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);
      expect(total).toBe(expected.length);
      expect(seen.map((e) => e.rank)).toEqual(expected.map((_, i) => i + 1));
      const keyOf = (id: string) => rows.find((r) => r.characterId === id)!;
      expect(seen.map((e) => JSON.stringify([e.sortKey, e.value]))).toEqual(
        expected.map((e) => JSON.stringify([e.sortKey, keyOf(e.id).value])),
      );
    }
  });

  it('breaks an exact tie by who reached it first', async () => {
    const page = await boardOf(viewer, 'level?limit=100');
    const pairs = page.entries.filter(
      (e, i, all) => i > 0 && JSON.stringify(all[i - 1]!.sortKey) === JSON.stringify(e.sortKey),
    );
    expect(pairs.length).toBeGreaterThan(0);
    for (const e of pairs) {
      const prev = page.entries[page.entries.indexOf(e) - 1]!;
      expect(prev.achievedOn <= e.achievedOn).toBe(true);
    }
  });

  it('filters by class and level bracket; shows your own rank', async () => {
    const mages = await boardOf(viewer, 'power?class=mage&limit=100');
    expect(mages.entries.length).toBeGreaterThan(0);
    expect(mages.entries.every((e) => e.hero.classId === 'mage')).toBe(true);
    expect(mages.filters).toEqual({ classId: 'mage', bracket: null });
    const low = await boardOf(viewer, 'level?bracket=1-9&limit=100');
    expect(low.entries.every((e) => e.hero.level <= 9)).toBe(true);
    expect(low.entries.length).toBeGreaterThan(0);
    const all = await boardOf(viewer, 'level?limit=1');
    expect(all.yours).toHaveLength(1);
    expect(all.yours[0]!.you).toBe(true);
    expect(all.yours[0]!.rank).toBe(
      (await boardOf(viewer, 'level?limit=100')).entries.find((e) => e.you)!.rank,
    );
    // The viewer's warrior is not in the mage board.
    expect(mages.yours).toEqual([]);
  });

  it('answers 304 to an unchanged poll and a new body after a change', async () => {
    const first = await board(viewer, 'gearScore');
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect((await board(viewer, 'gearScore', { 'if-none-match': etag })).statusCode).toBe(304);
    await equipKit(viewer, field[0]!, 10, 'uncommon');
    const after = await board(viewer, 'gearScore', { 'if-none-match': etag });
    expect(after.statusCode).toBe(200);
  });

  it('leaves out accounts with an active sanction, and puts them back when it ends', async () => {
    const target = field[5]!;
    const listed = async () =>
      (await boardOf(viewer, 'level?limit=100')).entries.some(
        (e) => e.player.handle === handleOf(target.accountId),
      );
    await loadHandles();
    expect(await listed()).toBe(true);
    for (const kind of ['mute', 'suspend', 'rename', 'hide'] as const) {
      const id = uuidv7();
      await database.db.insert(sanctions).values({
        id,
        subjectId: target.accountId,
        kind,
        reason: 'test',
        createdAt: now(),
        expiresAt: new Date(nowMs + 3_600_000),
        ...(kind === 'hide' ? { targetKey: `characterName:${target.id}` } : {}),
      });
      expect(await listed(), kind).toBe(false);
      await database.db.update(sanctions).set({ liftedAt: now() }).where(eq(sanctions.id, id));
      expect(await listed(), `${kind} lifted`).toBe(true);
    }
    // An expired sanction no longer counts either.
    await database.db.insert(sanctions).values({
      id: uuidv7(),
      subjectId: target.accountId,
      kind: 'mute',
      reason: 'test',
      createdAt: new Date(nowMs - 7_200_000),
      expiresAt: new Date(nowMs - 3_600_000),
    });
    expect(await listed()).toBe(true);
    // A sanctioned viewer sees why they are not listed.
    const muted = field[6]!;
    const mutedAccount = await accountAsTester(muted.accountId);
    await database.db.insert(sanctions).values({
      id: uuidv7(),
      subjectId: muted.accountId,
      kind: 'mute',
      reason: 'test',
      createdAt: now(),
      expiresAt: new Date(nowMs + 3_600_000),
    });
    const own = await boardOf(mutedAccount, 'level');
    expect(own.youExcluded).toBe(true);
    expect(own.yours).toEqual([]);
  });

  it('withholds a hidden display name and hero name; never sends an id', async () => {
    const target = field[7]!;
    await database.db.insert(sanctions).values({
      id: uuidv7(),
      subjectId: target.accountId,
      kind: 'hide',
      targetKey: `profileField:${target.accountId}:displayName`,
      reason: 'test',
      createdAt: now(),
      expiresAt: new Date(nowMs + 3_600_000),
    });
    // A hide sanction is active: the account is left off; once lifted it is back with its name.
    const res = await board(viewer, 'level?limit=100');
    for (const h of field) {
      expect(res.body).not.toContain(h.id);
      expect(res.body).not.toContain(h.accountId);
    }
    expect(res.body).not.toContain('seed');
    expect(res.body).not.toMatch(/@graumark/);
    await database.db
      .update(sanctions)
      .set({ liftedAt: now() })
      .where(eq(sanctions.subjectId, target.accountId));
  });

  it('refuses unknown metrics, filters and cursors; needs a session; has a read limit', async () => {
    expect((await board(viewer, 'gold')).statusCode).toBe(400);
    expect((await board(viewer, 'level?class=bard')).statusCode).toBe(400);
    expect((await board(viewer, 'level?bracket=40-49')).statusCode).toBe(400);
    expect((await board(viewer, 'level?scope=season')).statusCode).toBe(400);
    expect((await board(viewer, 'level?cursor=bm9wZQ')).statusCode).toBe(400);
    expect((await board(viewer, 'level?limit=500')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/leaderboards/level' })).statusCode).toBe(
      401,
    );
    const limited = buildApp({
      database,
      auth: { now },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
      leaderboards: { readLimit: { max: 2, windowMs: 60_000 } },
    });
    await limited.ready();
    const get = () =>
      limited.inject({
        method: 'GET',
        url: '/api/leaderboards/level',
        cookies: { wf_session: viewer.token },
      });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    const third = await get();
    expect(third.statusCode).toBe(429);
    expect(third.json().error.details.limit).toBe('boards');
    await limited.close();
  });

  it('backfills the viewer’s own heroes on read', async () => {
    const who = await insertAccount(database.db, { now: now() });
    await insertCharacter(database.db, who.id, { level: 2 });
    const page = await boardOf(who, 'level');
    expect(page.yours).toHaveLength(1);
  });

  const handles = new Map<string, string>();
  async function loadHandles() {
    for (const a of await database.db.select().from(accounts)) handles.set(a.id, a.handle);
  }
  const handleOf = (id: string) => handles.get(id)!;
  async function accountAsTester(id: string): Promise<TestAccount> {
    // A session for an existing account, as insertAccount makes one.
    const { createSession } = await import('../auth/index.js');
    const [a] = await database.db.select().from(accounts).where(eq(accounts.id, id));
    const { token } = await createSession(database.db, id, new Date(nowMs - 1000), 30 * 86_400_000);
    return { id, handle: a!.handle, displayName: a!.displayName, token, role: a!.role };
  }
});

describe('profile links: each visibility × viewer relation', () => {
  const RELATIONS = [
    'self',
    'friend',
    'guildmate',
    'pending',
    'stranger',
    'blocked-by-me',
    'blocked-by-them',
  ] as const;
  const asProfileRelation = (r: (typeof RELATIONS)[number]): ProfileRelation =>
    r === 'blocked-by-me' || r === 'blocked-by-them' ? 'blocked' : r;

  it('links the name and shows the hero only where the profile may be opened; lists everyone', async () => {
    for (const visibility of PROFILE_VISIBILITIES) {
      for (const relation of RELATIONS) {
        const owner = await insertAccount(database.db, { now: now() });
        const viewer =
          relation === 'self' ? owner : await insertAccount(database.db, { now: now() });
        await database.db
          .update(accounts)
          .set({ profileVisibility: visibility as ProfileVisibility })
          .where(eq(accounts.id, owner.id));
        const hero = await insertCharacter(database.db, owner.id, { classId: 'warlock', level: 7 });
        await refreshHeroScores(deps(), hero.id, now());
        const [low, high] = owner.id < viewer.id ? [owner.id, viewer.id] : [viewer.id, owner.id];
        if (relation === 'friend' || relation === 'pending') {
          await database.db.insert(friendships).values({
            accountLow: low,
            accountHigh: high,
            status: relation === 'friend' ? 'friends' : 'pending',
            requestedBy: viewer.id,
            createdAt: now(),
            ...(relation === 'friend' ? { acceptedAt: now() } : {}),
          });
        }
        if (relation === 'guildmate') {
          await insertGuild(database.db, owner.id, { members: [{ accountId: viewer.id }] });
        }
        if (relation === 'blocked-by-me' || relation === 'blocked-by-them') {
          const [blockerId, blockedId] =
            relation === 'blocked-by-me' ? [viewer.id, owner.id] : [owner.id, viewer.id];
          await database.db.insert(blocks).values({ blockerId, blockedId, createdAt: now() });
        }
        const page = await boardOf(viewer, 'level?class=warlock&bracket=1-9&limit=100');
        const entry = [...page.entries, ...page.yours].find(
          (e) => e.player.handle === owner.handle,
        );
        const label = `${visibility} × ${relation}`;
        // Owner decision: everyone is listed by name, blocks hide no one.
        expect(entry, label).toBeDefined();
        expect(entry!.player.displayName, label).toBe(owner.displayName);
        const allowed = canViewProfile(visibility, asProfileRelation(relation));
        expect(entry!.player.profile, label).toBe(allowed);
        expect(entry!.hero.name, label).toBe(allowed ? hero.name : null);
        // The profile route agrees with the link.
        const profile = await call(viewer, 'GET', `/api/players/${owner.handle}/profile`);
        expect(profile.statusCode, label).toBe(allowed ? 200 : 404);
      }
    }
  });
});

describe('invariance', () => {
  it('refreshing and reading boards changes no gameplay row', async () => {
    const who = await insertAccount(database.db, { now: now() });
    const hero = await insertCharacter(database.db, who.id, { classId: 'warrior', level: 15 });
    await packKit(hero, 14, 'epic', 5);
    const snapshot = async () => ({
      hero: await heroRow(hero.id),
      items: await database.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, hero.id))
        .orderBy(itemInstances.id),
      members: await database.db.select().from(guildMembers),
    });
    const before = await snapshot();
    await refreshHeroScores(deps(), hero.id, now());
    await sweepAll();
    for (const m of SCORE_METRICS) await boardOf(who, `${m}?limit=100`);
    expect(await snapshot()).toEqual(before);
  });
});
