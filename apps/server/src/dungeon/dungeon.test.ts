import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  activities,
  auditLog,
  characterMaterials,
  characters,
  dungeonRuns,
  itemInstances,
  telemetryDaily,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import { replayRun, type DungeonClaimResponse, type DungeonStateResponse } from './routes.js';
import type { DungeonRunView } from './routes.js';
import type { WorldStateResponse } from '../world/routes.js';
import type { QuestBoardResponse } from '../quests/store.js';
import {
  STORY_QUEST_IDS,
  bossModifierOfWeek,
  guildBossWeek,
  simulateDungeonRun,
  type RarityId,
} from '@worldforge/game-core';
import { characterQuests } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';

const SEC = 1000;
const HOUR = 3600 * SEC;

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-02T12:00:00Z');
const advance = (ms: number) => {
  nowMs += ms;
};
const options: ActivityOptions = {
  ...DEFAULT_ACTIVITY_OPTIONS,
  offlineCapMs: 3 * HOUR,
  now: () => new Date(nowMs),
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } },
    activity: options,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface Player {
  token: string;
  accountId: string;
}

let seq = 0;
const tag = () => {
  seq += 1;
  let n = seq;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return s;
};

async function newPlayer(): Promise<Player> {
  const t = tag();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `delver-${t}@graumark.test`,
      displayName: `Delver ${t}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${res.statusCode}`);
  return { token, accountId: res.json<{ account: { id: string } }>().account.id };
}

async function newCharacter(p: Player, classId = 'warrior'): Promise<string> {
  const res = await call(p, 'POST', '/api/characters', {
    name: `Delver${tag()}`,
    classId,
    appearance: { banner: 'ash' },
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json<{ character: { id: string } }>().character.id;
}

const call = (
  p: Player,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers,
    cookies: { [SESSION_COOKIE]: p.token },
  });

const enter = (p: Player, id: string) =>
  call(p, 'POST', `/api/characters/${id}/dungeon`, { dungeonId: 'namelessCrypt' });
const settle = (p: Player, id: string) => call(p, 'POST', `/api/characters/${id}/dungeon/settle`);
const claim = (p: Player, id: string, key: string | null = `claim-${tag()}-key`) =>
  call(
    p,
    'POST',
    `/api/characters/${id}/dungeon/claim`,
    undefined,
    key ? { 'idempotency-key': key } : {},
  );
const farm = (p: Player, id: string, areaId = 'abandonedFields') =>
  call(p, 'POST', `/api/characters/${id}/activity`, { areaId });

async function hero(classId = 'warrior', level = 16, gear = true, rarityId: RarityId = 'uncommon') {
  const p = await newPlayer();
  const id = await newCharacter(p, classId);
  await makeCryptReady(database.db, id, classId as 'warrior', level, { gear, rarityId });
  return { p, id };
}

const enterTier = (p: Player, id: string, tier: unknown) =>
  call(p, 'POST', `/api/characters/${id}/dungeon`, { dungeonId: 'namelessCrypt', tier });

async function setProgress(characterId: string, progress: Record<string, unknown>) {
  await database.db
    .update(characters)
    .set({ progress: progress as never })
    .where(eq(characters.id, characterId));
}

/** Pins a run's seed (and its end time) so two runs can be compared. */
async function pinSeed(characterId: string, seed: string) {
  const [run] = await database.db
    .select()
    .from(dungeonRuns)
    .where(and(eq(dungeonRuns.characterId, characterId), isNull(dungeonRuns.claimedAt)));
  const pinned = { ...run!, seedSecret: seed };
  const endsAt = new Date(run!.startedAt.getTime() + replayRun(pinned).durationMs);
  await database.db
    .update(dungeonRuns)
    .set({ seedSecret: seed, endsAt })
    .where(eq(dungeonRuns.id, run!.id));
  return endsAt;
}

async function owned(characterId: string) {
  const items = await database.db
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, characterId));
  const mats = await database.db
    .select()
    .from(characterMaterials)
    .where(eq(characterMaterials.characterId, characterId));
  const [c] = await database.db.select().from(characters).where(eq(characters.id, characterId));
  return { items, mats, character: c! };
}

describe('the Nameless Crypt (ticket 2.5)', () => {
  it('refuses heroes below the dungeon level and inactive characters', async () => {
    const { p, id } = await hero('warrior', 11, false);
    const res = await enter(p, id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'dungeon_locked', details: { blockers: [{ kind: 'level', required: 12 }] } },
    });
    const other = await newCharacter(p);
    await makeCryptReady(database.db, other, 'warrior', 16, { gear: false });
    await call(p, 'POST', `/api/characters/${id}/select`);
    expect((await enter(p, other)).json()).toMatchObject({
      error: { code: 'character_not_active' },
    });
    expect((await enter(await newPlayer(), id)).statusCode).toBe(404);
    const bad = await call(p, 'POST', `/api/characters/${id}/dungeon`, { dungeonId: 'nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('a full run: leaves the fields, reveals the run over time, claims once, opens the Abbey', async () => {
    const { p, id } = await hero();
    expect((await farm(p, id)).statusCode).toBe(201);
    advance(60 * SEC);

    const started = await enter(p, id);
    expect(started.statusCode).toBe(201);
    const run = started.json<{ run: DungeonRunView }>().run;
    expect(JSON.stringify(started.json())).not.toMatch(/seed/i);
    expect(run.progress).toMatchObject({ finished: false, outcome: null, elapsedMs: 0 });
    // Farming was settled and stopped; the run blocks farming for the whole account.
    expect(
      await database.db.select().from(activities).where(eq(activities.characterId, id)),
    ).toEqual([]);
    const stopAudit = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, id), eq(auditLog.event, 'activity.stop')));
    expect(stopAudit.at(-1)!.data).toMatchObject({ reason: 'dungeon_started' });
    expect((await farm(p, id)).json()).toMatchObject({ error: { code: 'in_dungeon' } });
    const second = await newCharacter(p);
    expect((await farm(p, second)).json()).toMatchObject({ error: { code: 'in_dungeon' } });
    await call(p, 'POST', `/api/characters/${id}/select`);
    expect((await enter(p, id)).json()).toMatchObject({ error: { code: 'dungeon_run_open' } });

    advance(30 * SEC);
    const mid = (await settle(p, id)).json<{ run: DungeonRunView }>().run;
    expect(mid.progress.finished).toBe(false);
    expect(mid.progress.outcome).toBeNull();
    expect(mid.progress.events.every((e) => e.t <= 30 * SEC)).toBe(true);
    expect((await claim(p, id)).json()).toMatchObject({ error: { code: 'run_in_progress' } });

    nowMs = Date.parse(run.endsAt);
    const done = (await settle(p, id)).json<{ run: DungeonRunView }>().run;
    expect(done.progress).toMatchObject({ finished: true, outcome: 'cleared', stage: 'done' });

    expect((await claim(p, id, null)).json()).toMatchObject({
      error: { code: 'idempotency_key_required' },
    });
    const before = await owned(id);
    const key = 'claim-gravewarden-0001';
    const first = await claim(p, id, key);
    expect(first.statusCode).toBe(200);
    const { result, character } = first.json<DungeonClaimResponse>();
    expect(result).toMatchObject({
      outcome: 'cleared',
      bossDefeated: true,
      bossLoot: true,
      firstBossKill: true,
      roomsCleared: 4,
      materials: { gravewardenSeal: 1 },
      questEvents: [{ type: 'bossDefeated', bossId: 'gravewarden' }],
    });
    expect(character.gold).toBe(before.character.gold + result.goldGained);
    const after = await owned(id);
    expect(after.items.length - before.items.length).toBe(result.items.length);
    expect(after.mats.find((m) => m.materialId === 'gravewardenSeal')?.quantity).toBe(1);
    expect(after.character.progress.gravewardenDefeated).toBe(true);
    // Ticket T.1: chamber drops keep `dungeon:…`, the boss hoard's are `hoard:…` and account-bound.
    const fromRun = after.items.filter(
      (i) => i.source === 'dungeon:namelessCrypt' || i.source === 'hoard:namelessCrypt',
    );
    expect(fromRun).toHaveLength(result.items.length);
    const hoardItems = fromRun.filter((i) => i.source === 'hoard:namelessCrypt');
    expect(hoardItems.length).toBeGreaterThan(0);
    for (const i of hoardItems) expect(i.binding).toBe('account');

    // Retrying the same claim replays the stored response and grants nothing new.
    const retry = await claim(p, id, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    // A new key finds nothing left to claim.
    expect((await claim(p, id)).json()).toMatchObject({ error: { code: 'no_dungeon_run' } });
    expect(await owned(id)).toEqual(after);
    const claims = await database.db
      .select({ n: count() })
      .from(auditLog)
      .where(and(eq(auditLog.characterId, id), eq(auditLog.event, 'dungeon.claim')));
    expect(claims[0]!.n).toBe(1);

    // The same key on another request is a conflict.
    const other = await call(p, 'POST', `/api/characters/${second}/dungeon/claim`, undefined, {
      'idempotency-key': key,
    });
    expect(other.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });

    // Free again: farming works, and the Sunken Abbey is no longer boss-gated.
    expect((await farm(p, id)).statusCode).toBe(201);
    const world = (await call(p, 'GET', `/api/characters/${id}/world`)).json<WorldStateResponse>();
    expect(world.progress.gravewardenDefeated).toBe(true);
    expect(world.areas.find((a) => a.id === 'sunkenAbbey')!.blockers).toEqual([
      { kind: 'level', required: 17 },
    ]);
  });

  it('boss loot has a cooldown: the next run counts the kill but drops no seal', async () => {
    const { p, id } = await hero();
    let run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
    expect(run.bossLootEligible).toBe(true);
    nowMs = Date.parse(run.endsAt);
    expect((await claim(p, id)).json<DungeonClaimResponse>().result.bossLoot).toBe(true);

    const state = (
      await call(p, 'GET', `/api/characters/${id}/dungeon`)
    ).json<DungeonStateResponse>();
    expect(state.run).toBeNull();
    expect(state.dungeons[0]!.bossLootReadyAt).toBe(
      new Date(Date.parse(run.startedAt) + 20 * HOUR).toISOString(),
    );

    run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
    expect(run.bossLootEligible).toBe(false);
    nowMs = Date.parse(run.endsAt);
    const second = (await claim(p, id)).json<DungeonClaimResponse>().result;
    expect(second).toMatchObject({
      bossDefeated: true,
      bossLoot: false,
      firstBossKill: false,
      materials: {},
    });
    expect(second.questEvents).toEqual([{ type: 'bossDefeated', bossId: 'gravewarden' }]);

    advance(20 * HOUR);
    run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
    expect(run.bossLootEligible).toBe(true);
  });

  it('a failed run keeps the room rewards and never removes progress', async () => {
    const { p, id } = await hero('mage', 12, false);
    const run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
    nowMs = Date.parse(run.endsAt);
    const { result, character } = (await claim(p, id)).json<DungeonClaimResponse>();
    expect(result).toMatchObject({
      outcome: 'failed',
      bossDefeated: false,
      bossLoot: false,
      materials: {},
    });
    expect(result.questEvents).toEqual([]);
    expect(result.xpGained).toBeGreaterThan(0);
    expect(character.level).toBeGreaterThanOrEqual(12);
    const c = await owned(id);
    expect(c.character.progress.gravewardenDefeated).toBe(false);
    expect(c.mats).toEqual([]);
  });

  it('settling often or never gives the same claimed result (invariance)', async () => {
    const a = await hero();
    const b = await hero();
    await enter(a.p, a.id);
    await enter(b.p, b.id);
    const endA = await pinSeed(a.id, 'invariance-run');
    const endB = await pinSeed(b.id, 'invariance-run');
    expect(endA).toEqual(endB);
    const startMs = nowMs;
    const duration = endA.getTime() - startMs;
    // A polls every 5 s (and tries to claim early); B only claims at the end.
    for (let t = 0; t <= duration + 5 * SEC; t += 5 * SEC) {
      nowMs = startMs + t;
      expect((await settle(a.p, a.id)).statusCode).toBe(200);
      if (t < duration) expect((await claim(a.p, a.id)).statusCode).toBe(409);
    }
    nowMs = startMs + duration + 5 * SEC;
    const ra = (await claim(a.p, a.id)).json<DungeonClaimResponse>().result;
    const rb = (await claim(b.p, b.id)).json<DungeonClaimResponse>().result;
    const strip = (r: typeof ra) => ({
      ...r,
      runId: '',
      items: r.items.map((i) => ({ ...i, id: '' })),
    });
    expect(strip(ra)).toEqual(strip(rb));
    const pick = (rows: Awaited<ReturnType<typeof owned>>) => ({
      items: rows.items
        .map((i) => [i.baseId, i.rarityId, i.itemLevel, i.seed, i.affixes, i.equippedSlot])
        .sort((x, y) => String(x).localeCompare(String(y))),
      mats: rows.mats.map((m) => [m.materialId, m.quantity]),
      level: rows.character.level,
      xp: rows.character.experience,
      gold: rows.character.gold,
      progress: rows.character.progress,
    });
    expect(pick(await owned(a.id))).toEqual(pick(await owned(b.id)));
  });

  it('snapshots equipped effects at the start; the run replays with them (ticket 3.2)', async () => {
    const { p, id } = await hero('warrior', 16);
    const [ring] = await database.db
      .select()
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, id), eq(itemInstances.equippedSlot, 'ring1')));
    await database.db
      .update(itemInstances)
      .set({ rarityId: 'legendary', effectId: 'tyrants-bane', effectRoll: 1 })
      .where(eq(itemInstances.id, ring!.id));
    expect((await enter(p, id)).statusCode).toBe(201);
    await pinSeed(id, 'effects-pinned');
    const [run] = await database.db
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.characterId, id), isNull(dungeonRuns.claimedAt)));
    const worn = run!.snapshot.equipment.find((e) => e.effectId === 'tyrants-bane');
    expect(worn).toMatchObject({ effectRoll: 1 });
    // Boss slayer makes the boss fight shorter than the same run without the effect.
    const withEffect = replayRun(run!);
    const without = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map((e) => ({ ...e, effectId: null, effectRoll: null })),
      },
    });
    const bossTime = (r: typeof withEffect) => {
      const b = r.encounters.at(-1)!;
      return b.endMs - b.startMs;
    };
    expect(withEffect.bossDefeated).toBe(true);
    expect(bossTime(withEffect)).toBeLessThan(bossTime(without));
    // Changing gear after the start cannot change the run: it replays from the snapshot.
    await database.db
      .update(itemInstances)
      .set({ effectId: null, effectRoll: null })
      .where(eq(itemInstances.id, ring!.id));
    expect(replayRun(run!)).toEqual(withEffect);
  });

  it('snapshots equipped set pieces at the start; the run replays with the bonus (ticket 3.3)', async () => {
    const { p, id } = await hero('warrior', 16);
    const worn = await database.db
      .select()
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, id), isNotNull(itemInstances.equippedSlot)));
    // Turn the equipped helm and chest into two Drowned Vigil pieces (2-piece bonus: thorns).
    for (const [slot, baseId] of [
      ['head', 'vigil-helm'],
      ['chest', 'vigil-hauberk'],
    ] as const) {
      const row = worn.find((r) => r.equippedSlot === slot)!;
      await database.db
        .update(itemInstances)
        .set({ baseId, rarityId: 'legendary', setId: 'drowned-vigil' })
        .where(eq(itemInstances.id, row.id));
    }
    expect((await enter(p, id)).statusCode).toBe(201);
    await pinSeed(id, 'sets-pinned');
    const [run] = await database.db
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.characterId, id), isNull(dungeonRuns.claimedAt)));
    expect(run!.snapshot.equipment.filter((e) => e.setId === 'drowned-vigil')).toHaveLength(2);
    const withSet = replayRun(run!);
    const without = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map((e) => ({ ...e, setId: null })),
      },
    });
    // Thorns: the enemies take damage when they hit, so the run plays out differently.
    expect(withSet.events).not.toEqual(without.events);
    // Older snapshots have no set ids and replay without bonuses.
    const legacy = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map(({ setId: _, ...e }) => e),
      },
    });
    expect(legacy).toEqual(without);
    // Changing gear after the start cannot change the run.
    await database.db
      .update(itemInstances)
      .set({ setId: null })
      .where(eq(itemInstances.characterId, id));
    expect(replayRun(run!)).toEqual(withSet);
  });

  it('snapshots upgrade levels at the start; older snapshots replay at +0 (ticket 3.4)', async () => {
    const { p, id } = await hero('warrior', 16);
    await database.db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(and(eq(itemInstances.characterId, id), isNotNull(itemInstances.equippedSlot)));
    expect((await enter(p, id)).statusCode).toBe(201);
    await pinSeed(id, 'upgrades-pinned');
    const [run] = await database.db
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.characterId, id), isNull(dungeonRuns.claimedAt)));
    expect(run!.snapshot.equipment.length).toBeGreaterThan(0);
    expect(run!.snapshot.equipment.every((e) => e.upgradeLevel === 10)).toBe(true);
    const upgraded = replayRun(run!);
    const plain = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map((e) => ({ ...e, upgradeLevel: 0 })),
      },
    });
    expect(upgraded.events).not.toEqual(plain.events);
    const legacy = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map(({ upgradeLevel: _, ...e }) => e),
      },
    });
    expect(legacy).toEqual(plain);
    // Upgrading (or losing) gear after the start cannot change the run.
    await database.db
      .update(itemInstances)
      .set({ upgradeLevel: 0 })
      .where(eq(itemInstances.characterId, id));
    expect(replayRun(run!)).toEqual(upgraded);
  });

  it('snapshots the Void variant at the start; older snapshots replay without it (ticket 3.5)', async () => {
    const { p, id } = await hero('warrior', 16);
    // The hero's gear as Void Legendaries (Void applies only on Legendary and Mythic items).
    await database.db
      .update(itemInstances)
      .set({ rarityId: 'legendary', variant: 'void' })
      .where(and(eq(itemInstances.characterId, id), isNotNull(itemInstances.equippedSlot)));
    expect((await enter(p, id)).statusCode).toBe(201);
    await pinSeed(id, 'void-pinned');
    const [run] = await database.db
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.characterId, id), isNull(dungeonRuns.claimedAt)));
    expect(run!.snapshot.equipment.length).toBeGreaterThan(0);
    expect(run!.snapshot.equipment.every((e) => e.variant === 'void')).toBe(true);
    const withVoid = replayRun(run!);
    const plain = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map((e) => ({ ...e, variant: null })),
      },
    });
    expect(withVoid.events).not.toEqual(plain.events);
    const legacy = replayRun({
      ...run!,
      snapshot: {
        ...run!.snapshot,
        equipment: run!.snapshot.equipment.map(({ variant: _, ...e }) => e),
      },
    });
    expect(legacy).toEqual(plain);
    await database.db
      .update(itemInstances)
      .set({ variant: null })
      .where(eq(itemInstances.characterId, id));
    expect(replayRun(run!)).toEqual(withVoid);
  });

  describe('tiers (ticket 3.6)', () => {
    it('shows every tier with its gate and loot focus; a deeper tier needs the one before', async () => {
      const { p, id } = await hero('warrior', 18);
      const state = (
        await call(p, 'GET', `/api/characters/${id}/dungeon`)
      ).json<DungeonStateResponse>();
      const crypt = state.dungeons[0]!;
      expect(crypt.tiers.map((t) => t.tier)).toEqual([1, 2, 3, 4]);
      expect(crypt.tierCleared).toBe(0);
      // Ticket 6.3: Heroic, gated on level 32 and tier III cleared.
      expect(crypt.tiers[3]).toMatchObject({
        name: 'Heroic',
        heroic: true,
        unlocked: false,
        blockers: [
          { kind: 'level', required: 32 },
          { kind: 'cryptTier', tier: 3 },
        ],
        lootFocus: { id: 'crypt-iv', name: 'Heroic spoils' },
      });
      expect(crypt.tiers.slice(0, 3).every((t) => !t.heroic)).toBe(true);
      expect(crypt.tiers[0]).toMatchObject({ unlocked: true, blockers: [], minLevel: 12 });
      expect(crypt.tiers[1]).toMatchObject({
        unlocked: false,
        blockers: [{ kind: 'cryptTier', tier: 1 }],
        lootFocus: { id: 'crypt-ii', name: 'The Drowned Vigil' },
      });
      expect(crypt.tiers[2]!.blockers).toEqual([
        { kind: 'level', required: 21 },
        { kind: 'cryptTier', tier: 2 },
      ]);
      for (const t of crypt.tiers) expect(t.lootFocus?.description.length).toBeGreaterThan(0);
      const locked = await enterTier(p, id, 2);
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({
        error: {
          code: 'dungeon_locked',
          details: { tier: 2, blockers: [{ kind: 'cryptTier', tier: 1 }] },
        },
      });
      for (const bad of [0, 5, 9, 'two', 1.5]) {
        expect((await enterTier(p, id, bad)).statusCode, String(bad)).toBe(400);
      }
      // A pre-3.6 Gravewarden kill counts as tier I cleared.
      await setProgress(id, { gravewardenDefeated: true });
      const after = (
        await call(p, 'GET', `/api/characters/${id}/dungeon`)
      ).json<DungeonStateResponse>();
      expect(after.dungeons[0]!.tierCleared).toBe(1);
      expect(after.dungeons[0]!.tiers[1]).toMatchObject({ unlocked: true, blockers: [] });
      expect(
        await database.db.select().from(dungeonRuns).where(eq(dungeonRuns.characterId, id)),
      ).toEqual([]);
    });

    it('a tier II clear: stored tier, claim clears it, opens tier III; boss loot cooldown is shared', async () => {
      const { p, id } = await hero('warrior', 21, true, 'legendary');
      await setProgress(id, { gravewardenDefeated: true });
      const started = await enterTier(p, id, 2);
      expect(started.statusCode).toBe(201);
      const run = started.json<{ run: DungeonRunView }>().run;
      expect(run.tier).toBe(2);
      expect(run.bossLootEligible).toBe(true);
      const [row] = await database.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
      expect(row!.tier).toBe(2);
      const replay = replayRun(row!);
      expect(replay.tier).toBe(2);
      expect(replay.outcome).toBe('cleared');
      nowMs = row!.endsAt.getTime();
      const res = await claim(p, id);
      expect(res.statusCode).toBe(200);
      const { result, character } = res.json<DungeonClaimResponse>();
      expect(result).toMatchObject({
        tier: 2,
        outcome: 'cleared',
        firstTierClear: true,
        firstBossKill: false,
      });
      expect(character.id).toBe(id);
      expect((await owned(id)).character.progress).toEqual({
        gravewardenDefeated: true,
        cryptTierCleared: 2,
      });
      const audits = await database.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.characterId, id)));
      expect(audits.find((a) => a.event === 'dungeon.start')!.data).toMatchObject({ tier: 2 });
      expect(audits.find((a) => a.event === 'dungeon.claim')!.data).toMatchObject({ tier: 2 });
      // Tier III is open now; its boss loot shares the cooldown the tier II hoard started.
      const state = (
        await call(p, 'GET', `/api/characters/${id}/dungeon`)
      ).json<DungeonStateResponse>();
      expect(state.dungeons[0]!.tiers[2]).toMatchObject({ unlocked: true, blockers: [] });
      expect(state.dungeons[0]!.bossLootReadyAt).not.toBeNull();
      const third = await enterTier(p, id, 3);
      expect(third.statusCode).toBe(201);
      expect(third.json<{ run: DungeonRunView }>().run).toMatchObject({
        tier: 3,
        bossLootEligible: false,
      });
      // A lower tier cleared again never lowers the progress.
      nowMs = (
        await database.db
          .select()
          .from(dungeonRuns)
          .where(and(eq(dungeonRuns.characterId, id), isNull(dungeonRuns.claimedAt)))
      )[0]!.endsAt.getTime();
      const second = (await claim(p, id)).json<DungeonClaimResponse>();
      expect(second.result.tier).toBe(3);
      expect((await owned(id)).character.progress.cryptTierCleared).toBe(
        second.result.bossDefeated ? 3 : 2,
      );
      await enterTier(p, id, 1);
      nowMs += HOUR;
      const third1 = (await claim(p, id)).json<DungeonClaimResponse>();
      expect(third1.result).toMatchObject({ tier: 1, firstTierClear: false });
      expect((await owned(id)).character.progress.cryptTierCleared).toBeGreaterThanOrEqual(2);
    });

    it('settling often or never gives the same tier III claim (invariance)', async () => {
      const a = await hero('hunter', 22, true, 'legendary');
      const b = await hero('hunter', 22, true, 'legendary');
      for (const h of [a, b]) {
        await setProgress(h.id, { gravewardenDefeated: true, cryptTierCleared: 2 });
        expect((await enterTier(h.p, h.id, 3)).statusCode).toBe(201);
      }
      const endA = await pinSeed(a.id, 'tier3-invariance');
      const endB = await pinSeed(b.id, 'tier3-invariance');
      expect(endA).toEqual(endB);
      const startMs = nowMs;
      const duration = endA.getTime() - startMs;
      for (let t = 0; t <= duration + 7 * SEC; t += 7 * SEC) {
        nowMs = startMs + t;
        const s = (await settle(a.p, a.id)).json<{ run: DungeonRunView }>().run;
        expect(s.tier).toBe(3);
        if (t < duration) expect((await claim(a.p, a.id)).statusCode).toBe(409);
      }
      nowMs = startMs + duration + 7 * SEC;
      const ra = (await claim(a.p, a.id)).json<DungeonClaimResponse>().result;
      const rb = (await claim(b.p, b.id)).json<DungeonClaimResponse>().result;
      const strip = (r: typeof ra) => ({
        ...r,
        runId: '',
        items: r.items.map((i) => ({ ...i, id: '' })),
      });
      expect(strip(ra)).toEqual(strip(rb));
      expect(ra.tier).toBe(3);
      const pick = (rows: Awaited<ReturnType<typeof owned>>) => ({
        items: rows.items
          .map((i) => [i.baseId, i.rarityId, i.itemLevel, i.seed, i.affixes, i.setId, i.variant])
          .sort((x, y) => String(x).localeCompare(String(y))),
        gold: rows.character.gold,
        xp: rows.character.experience,
        progress: rows.character.progress,
      });
      expect(pick(await owned(a.id))).toEqual(pick(await owned(b.id)));
    });
  });

  describe('Heroic and the weekly boss modifier (ticket 6.3)', () => {
    const stored = async (characterId: string) =>
      (
        await database.db
          .select()
          .from(dungeonRuns)
          .where(and(eq(dungeonRuns.characterId, characterId), isNull(dungeonRuns.claimedAt)))
      )[0]!;

    it('Heroic opens at level 32 with tier III cleared; a clear sets it and stores the modifier', async () => {
      const { p, id } = await hero('warrior', 31, true, 'legendary');
      await setProgress(id, { gravewardenDefeated: true, cryptTierCleared: 3 });
      const low = await enterTier(p, id, 4);
      expect(low.statusCode).toBe(409);
      expect(low.json().error.details.blockers).toEqual([{ kind: 'level', required: 32 }]);
      await makeCryptReady(database.db, id, 'warrior', 36, { gear: false });
      const started = await enterTier(p, id, 4);
      expect(started.statusCode).toBe(201);
      const view = started.json<{ run: DungeonRunView }>().run;
      const week = bossModifierOfWeek(nowMs).id;
      expect(view).toMatchObject({ tier: 4, bossModifier: { id: week } });
      // A winning seed, found with game-core's own rules (the outcome is decided by the seed).
      const row = await stored(id);
      let seed = '';
      for (let i = 0; i < 400 && !seed; i++)
        if (replayRun({ ...row, seedSecret: `heroic-win:${i}` }).outcome === 'cleared')
          seed = `heroic-win:${i}`;
      expect(seed).not.toBe('');
      nowMs = (await pinSeed(id, seed)).getTime();
      const res = await claim(p, id);
      expect(res.statusCode).toBe(200);
      const { result } = res.json<DungeonClaimResponse>();
      expect(result).toMatchObject({ tier: 4, bossModifier: week, firstTierClear: true });
      expect((await owned(id)).character.progress.cryptTierCleared).toBe(4);
      const audits = await database.db.select().from(auditLog).where(eq(auditLog.characterId, id));
      expect(audits.find((a) => a.event === 'dungeon.start')!.data).toMatchObject({
        tier: 4,
        bossModifier: week,
      });
      expect(audits.find((a) => a.event === 'dungeon.claim')!.data).toMatchObject({
        tier: 4,
        bossModifier: week,
      });
      const rows = await database.db
        .select()
        .from(telemetryDaily)
        .where(eq(telemetryDaily.metric, 'boss_modifier.run'));
      expect(
        rows.some((r) => r.dim1 === week && r.dim2 === 'namelessCrypt:4' && r.dim3 === 'won'),
      ).toBe(true);
    });

    it('a run keeps the modifier of the week it started in, across Monday 00:00 (window rule)', async () => {
      const edge = guildBossWeek(nowMs).endMs;
      const old = bossModifierOfWeek(edge - 1).id;
      const fresh = bossModifierOfWeek(edge).id;
      expect(fresh).not.toBe(old);
      // Started at Sunday 23:59:59.999: the old week's modifier, whenever it is claimed.
      nowMs = edge - 1;
      const { p, id } = await hero('hunter', 16);
      expect((await enter(p, id)).statusCode).toBe(201);
      const row = await stored(id);
      expect(row.bossModifier).toBe(old);
      nowMs = row.endsAt.getTime() + SEC;
      expect(nowMs).toBeGreaterThan(edge);
      const state = (
        await call(p, 'GET', `/api/characters/${id}/dungeon`)
      ).json<DungeonStateResponse>();
      expect(state.bossModifier.modifier.id).toBe(fresh);
      expect(state.dungeons.every((d) => d.bossModifier.id === fresh)).toBe(true);
      expect(state.run!.bossModifier!.id).toBe(old);
      const r = (await claim(p, id)).json<DungeonClaimResponse>().result;
      expect(r.bossModifier).toBe(old);
      const replay = replayRun(row);
      expect([r.outcome, r.durationMs, r.kills]).toEqual([
        replay.outcome,
        replay.durationMs,
        replay.kills,
      ]);
      // Started at the next Monday 00:00:00.000 exactly: that week's modifier.
      const b = await hero('hunter', 16);
      const next = guildBossWeek(nowMs).endMs;
      nowMs = next;
      expect((await enter(b.p, b.id)).statusCode).toBe(201);
      expect((await stored(b.id)).bossModifier).toBe(bossModifierOfWeek(next).id);
      expect(guildBossWeek(next).startMs).toBe(next);
    });

    it('a run from before 6.3 (no modifier) replays and claims exactly as it was', async () => {
      const { p, id } = await hero('warrior', 16);
      expect((await enter(p, id)).statusCode).toBe(201);
      const row = await stored(id);
      await database.db
        .update(dungeonRuns)
        .set({ bossModifier: null })
        .where(eq(dungeonRuns.id, row.id));
      const old = { ...row, bossModifier: null };
      const plain = simulateDungeonRun({
        dungeonId: 'namelessCrypt',
        tier: 1,
        character: {
          classId: row.snapshot.classId,
          level: row.snapshot.level,
          xp: row.snapshot.xp,
        },
        equipment: row.snapshot.equipment,
        seed: row.seedSecret,
        bossLootEligible: row.bossLootEligible,
        inventoryCount: 0,
      });
      expect(replayRun(old)).toEqual(plain);
      const endsAt = await pinSeed(id, row.seedSecret);
      nowMs = endsAt.getTime();
      const view = (await settle(p, id)).json<{ run: DungeonRunView }>().run;
      expect(view.bossModifier).toBeNull();
      const r = (await claim(p, id)).json<DungeonClaimResponse>().result;
      expect('bossModifier' in r).toBe(false);
      expect([r.outcome, r.durationMs]).toEqual([plain.outcome, plain.durationMs]);
    });
  });

  it('parallel claims grant once (same key: one result; other keys: refused)', async () => {
    const { p, id } = await hero();
    const run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
    nowMs = Date.parse(run.endsAt);
    const before = await owned(id);
    const same = await Promise.all([0, 1, 2].map(() => claim(p, id, 'parallel-claim-key')));
    const other = await Promise.all([0, 1].map(() => claim(p, id)));
    expect(same.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    for (const r of same) expect(r.json()).toEqual(same[0]!.json());
    expect(other.map((r) => r.json().error.code)).toEqual(['no_dungeon_run', 'no_dungeon_run']);
    const after = await owned(id);
    const result = same[0]!.json<DungeonClaimResponse>().result;
    expect(after.items.length - before.items.length).toBe(result.items.length);
    expect(after.character.gold - before.character.gold).toBe(result.goldGained);
  });

  describe('quests (ticket 2.4)', () => {
    /** Turns in the story chain before the crypt step and accepts "The Nameless Crypt". */
    async function onTheCryptStep(p: Player, id: string, { accept = true } = {}) {
      const before = STORY_QUEST_IDS.slice(0, STORY_QUEST_IDS.indexOf('theNamelessCrypt'));
      for (const questId of before) {
        await database.db.insert(characterQuests).values({
          id: uuidv7(),
          characterId: id,
          kind: 'story',
          questId,
          objectives: [],
          progress: [],
          reward: { xp: 0, gold: 0, materials: {}, item: null },
          status: 'turnedIn',
          acceptedAt: new Date(nowMs),
          turnedInAt: new Date(nowMs),
        });
      }
      if (accept) expect((await acceptCryptStep(p, id)).statusCode).toBe(201);
    }
    const acceptCryptStep = (p: Player, id: string) =>
      call(p, 'POST', `/api/characters/${id}/quests`, {
        kind: 'story',
        questId: 'theNamelessCrypt',
      });
    const cryptQuest = async (p: Player, id: string) => {
      const b = (await call(p, 'GET', `/api/characters/${id}/quests`)).json<QuestBoardResponse>();
      return b.quests.find((q) => q.questId === 'theNamelessCrypt')!;
    };

    it('defeating the Gravewarden completes the story step "The Nameless Crypt", once', async () => {
      const { p, id } = await hero();
      await onTheCryptStep(p, id);
      expect(await cryptQuest(p, id)).toMatchObject({ status: 'active', progress: [0] });

      const run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
      // Nothing counts before the result is claimed.
      nowMs = Date.parse(run.endsAt);
      expect((await settle(p, id)).statusCode).toBe(200);
      expect((await cryptQuest(p, id)).progress).toEqual([0]);

      const key = `quest-claim-${tag()}-key`;
      const claimed = (await claim(p, id, key)).json<DungeonClaimResponse>().result;
      expect(claimed.questEvents).toEqual([{ type: 'bossDefeated', bossId: 'gravewarden' }]);
      expect(await cryptQuest(p, id)).toMatchObject({ status: 'ready', progress: [1] });
      // A replayed claim does not run again.
      expect((await claim(p, id, key)).statusCode).toBe(200);
      expect((await cryptQuest(p, id)).progress).toEqual([1]);

      // The step can be turned in like any other quest.
      const quest = await cryptQuest(p, id);
      const turnIn = await call(
        p,
        'POST',
        `/api/characters/${id}/quests/${quest.id}/turn-in`,
        undefined,
        { 'idempotency-key': `turn-in-${tag()}-key` },
      );
      expect(turnIn.statusCode).toBe(200);
      const board = (
        await call(p, 'GET', `/api/characters/${id}/quests`)
      ).json<QuestBoardResponse>();
      expect(board.story.completed).toContain('theNamelessCrypt');
    });

    it('a step taken after the run started does not count that run (ticket 2.8)', async () => {
      // Exploit review: the run's outcome is fixed at its start and its events are applied at the
      // claim. Taking the quest between the end of a won run and its claim completed the step
      // without fighting for it.
      const { p, id } = await hero();
      await onTheCryptStep(p, id, { accept: false });
      const run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
      nowMs = Date.parse(run.endsAt);
      expect((await acceptCryptStep(p, id)).statusCode).toBe(201);
      const { result } = (await claim(p, id)).json<DungeonClaimResponse>();
      expect(result.bossDefeated).toBe(true);
      expect(await cryptQuest(p, id)).toMatchObject({ status: 'active', progress: [0] });

      // The next run, entered with the step taken, counts.
      advance(HOUR);
      const next = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
      nowMs = Date.parse(next.endsAt);
      const again = (await claim(p, id)).json<DungeonClaimResponse>().result;
      expect(again.bossDefeated).toBe(true);
      expect(await cryptQuest(p, id)).toMatchObject({ status: 'ready', progress: [1] });
    });

    it('a failed run does not advance the step', async () => {
      const { p, id } = await hero('mage', 12, false);
      await onTheCryptStep(p, id);
      const run = (await enter(p, id)).json<{ run: DungeonRunView }>().run;
      nowMs = Date.parse(run.endsAt);
      const { result } = (await claim(p, id)).json<DungeonClaimResponse>();
      expect(result.outcome).toBe('failed');
      expect(await cryptQuest(p, id)).toMatchObject({ status: 'active', progress: [0] });
    });
  });
});
