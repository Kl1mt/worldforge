import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  computeScore,
  defaultLoadout,
  settleFarming,
  simulateDuel,
  duelFighter,
  type ClassId,
  type Loadout,
  type WorldProgress,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accounts,
  activities,
  auditLog,
  characterLoadouts,
  characters,
  duelDefences,
  duels,
  seasons,
  telemetryDaily,
  telemetryDailyTest,
  type Character,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { arenaCalls, befriend, equipKit } from '../test/arena.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { loadProfessions } from '../materials/store.js';
import { scoringInput } from '../scores/routes.js';
import type { ArenaStateResponse } from '../arena/routes.js';
import type { SkillsResponse } from './routes.js';

/**
 * Ticket 9.2: skill loadouts on the server (docs/SKILLS.md). Never asserts a farming outcome: each
 * window is predicted from the stored seed and state with game-core (CLAUDE.md "Random outcomes").
 */

const MIN = 60_000;
const DAY = 86_400_000;
// Derived from the wall clock (CLAUDE.md "Dates"): noon UTC today.
const START = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
let nowMs = START;
const now = () => new Date(nowMs);

let database: DatabaseHandle;
let app: FastifyInstance;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

const DEEDS: WorldProgress = {
  gravewardenDefeated: true,
  forgeTyrantDefeated: true,
  hollowSovereignDefeated: true,
  // Ticket 9.3: the skill quests' deed flags teach the boss skills.
  forgeTyrantSkillLearned: true,
  hollowSovereignSkillLearned: true,
};

async function hero(classId: ClassId, level: number, progress?: WorldProgress) {
  const who = await insertAccount(db(), { now: now() });
  const h = await insertCharacter(db(), who.id, {
    classId,
    level,
    progress: progress ?? { gravewardenDefeated: true },
  });
  // The hero is the account's selected one (farming starts only for it).
  await db().update(accounts).set({ activeCharacterId: h.id }).where(eq(accounts.id, who.id));
  return { who, hero: h };
}

function call(who: TestAccount, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url: `/api${url}`,
    ...(payload ? { payload } : {}),
    headers: { 'idempotency-key': randomUUID() },
    cookies: { [SESSION_COOKIE]: who.token },
  });
}
const skills = (p: { who: TestAccount; hero: Character }) =>
  call(p.who, 'GET', `/characters/${p.hero.id}/skills`);
const save = (p: { who: TestAccount; hero: Character }, preset: number, l: Loadout) =>
  call(p.who, 'PUT', `/characters/${p.hero.id}/skills/presets/${preset}`, {
    actives: l.actives,
    passive: l.passive ?? null,
  });
const pick = (p: { who: TestAccount; hero: Character }, preset: number) =>
  call(p.who, 'POST', `/characters/${p.hero.id}/skills/preset`, { preset });
const audits = async (heroId: string, event: string) =>
  (await db().select().from(auditLog).where(eq(auditLog.event, event))).filter(
    (a) => a.characterId === heroId,
  );

/** The window the next settlement credits, predicted from the stored rows with game-core. */
async function predict(heroId: string, elapsedMs: number, loadout?: Loadout) {
  const [a] = await db().select().from(activities).where(eq(activities.characterId, heroId));
  const [c] = await db().select().from(characters).where(eq(characters.id, heroId));
  return {
    before: a!,
    result: settleFarming({
      character: {
        classId: c!.classId,
        level: c!.level,
        xp: c!.experience,
        ...(a!.health !== null ? { health: a!.health } : {}),
        momentum: a!.momentum,
        soulFragments: a!.soulFragments,
      },
      equipment: [],
      areaId: a!.areaId,
      seed: a!.seedSecret,
      firstCycle: a!.cycleIndex,
      durationMs: a!.carryMs + elapsedMs,
      inventoryCount: 0,
      professions: await loadProfessions(db(), heroId),
      lootFilter: null,
      ...(loadout ? { loadout } : {}),
    }),
  };
}

async function activityOf(heroId: string) {
  const [a] = await db().select().from(activities).where(eq(activities.characterId, heroId));
  return a!;
}

describe('the Skills screen’s data', () => {
  it('reads the default loadout everywhere, and lists what the hero has unlocked', async () => {
    const p = await hero('warrior', 30);
    const res = await skills(p);
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json<SkillsResponse>();
    expect(s).toMatchObject({
      classId: 'warrior',
      level: 30,
      activePreset: 1,
      resource: { max: 100, start: 0 },
      inForce: { actives: ['heavyStrike', null, null], passive: null },
      soulFragments: 0,
    });
    expect(s.presets.map((x) => [x.preset, x.isDefault, x.problems])).toEqual([
      [1, true, []],
      [2, true, []],
      [3, true, []],
    ]);
    expect(s.unlocked).toContain('execute'); // level 28
    expect(s.unlocked).toContain('battleRhythm'); // level 24
    expect(s.unlocked).not.toContain('earthsplitter'); // level 36
    expect(s.unlocked).not.toContain('forgebreaker'); // the Forge Tyrant's fall
    // Another account's hero is the same 404 as a missing one.
    const other = await hero('mage', 5);
    expect((await call(other.who, 'GET', `/characters/${p.hero.id}/skills`)).statusCode).toBe(404);
  });
});

describe('saving and switching loadouts', () => {
  const rend: Loadout = { actives: ['rend', 'execute', null], passive: 'berserker' };

  it('validates against the hero: class, slots and unlocks (level and deeds)', async () => {
    const p = await hero('warrior', 30);
    const bad = async (l: Loadout) => {
      const res = await save(p, 1, l);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_loadout');
    };
    await bad({ actives: ['heavyStrike', 'earthsplitter', null], passive: null }); // level 36
    await bad({ actives: ['heavyStrike', 'forgebreaker', null], passive: null }); // a deed
    await bad({ actives: ['firebolt', null, null], passive: null }); // a mage skill
    await bad({ actives: ['execute', null, null], passive: null }); // a spender in slot 1
    await bad({ actives: ['heavyStrike', 'execute', 'execute'], passive: null }); // twice
    // Unknown ids never reach the rules (the schema refuses them).
    expect((await save(p, 1, { actives: ['nope', null, null], passive: null })).statusCode).toBe(
      400,
    );
    expect((await save(p, 4, rend)).statusCode).toBe(400);
    expect(
      await db()
        .select()
        .from(characterLoadouts)
        .where(eq(characterLoadouts.characterId, p.hero.id)),
    ).toEqual([]);
    // With the deed, the Tyrant's skill is fine.
    const q = await hero('warrior', 40, DEEDS);
    const ok = await save(q, 1, { actives: ['heavyStrike', 'forgebreaker', null], passive: null });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('settles first with the old loadout, so no window mixes two (switching mid-settlement)', async () => {
    const p = await hero('warrior', 30);
    expect(
      (await call(p.who, 'POST', `/characters/${p.hero.id}/activity`, { areaId: 'sunkenAbbey' }))
        .statusCode,
    ).toBeLessThan(300);
    // 20 minutes with the default loadout, then the switch.
    nowMs += 20 * MIN;
    const first = await predict(p.hero.id, 20 * MIN);
    const res = await save(p, 1, rend);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<SkillsResponse>().inForce).toEqual({
      actives: ['rend', 'execute', null],
      passive: 'berserker',
    });
    const a1 = await activityOf(p.hero.id);
    expect(a1.settledAt.getTime()).toBe(nowMs);
    expect(a1.cycleIndex).toBe(first.before.cycleIndex + first.result.encounters);
    expect(a1.carryMs).toBe(first.result.unusedMs);
    const [c1] = await db().select().from(characters).where(eq(characters.id, p.hero.id));
    expect([c1!.level, c1!.experience]).toEqual([first.result.level, first.result.xp]);

    // The next 20 minutes fight with the new loadout.
    nowMs += 20 * MIN;
    const second = await predict(p.hero.id, 20 * MIN, rend);
    expect((await call(p.who, 'POST', `/characters/${p.hero.id}/activity/settle`)).statusCode).toBe(
      200,
    );
    const a2 = await activityOf(p.hero.id);
    expect(a2.cycleIndex).toBe(second.before.cycleIndex + second.result.encounters);
    const [c2] = await db().select().from(characters).where(eq(characters.id, p.hero.id));
    expect([c2!.level, c2!.experience]).toEqual([second.result.level, second.result.xp]);

    // Audited once; saving the same loadout again changes nothing and writes nothing.
    const saved = await audits(p.hero.id, 'skills.loadout_save');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.data).toMatchObject({
      preset: 1,
      inForce: true,
      before: defaultLoadout('warrior'),
      after: rend,
    });
    expect((await save(p, 1, rend)).statusCode).toBe(200);
    expect(await audits(p.hero.id, 'skills.loadout_save')).toHaveLength(1);
    // Back to the default: no row is left (a hero on the default is stored as before 9.2).
    expect((await save(p, 1, defaultLoadout('warrior'))).statusCode).toBe(200);
    expect(
      await db()
        .select()
        .from(characterLoadouts)
        .where(eq(characterLoadouts.characterId, p.hero.id)),
    ).toEqual([]);
  });

  it('keeps three presets; switching is idempotent, audited and counted by loadout', async () => {
    const p = await hero('warrior', 30);
    expect((await save(p, 2, rend)).statusCode).toBe(200);
    // Preset 2 is saved, not in force.
    expect((await skills(p)).json<SkillsResponse>()).toMatchObject({
      activePreset: 1,
      inForce: { actives: ['heavyStrike', null, null] },
    });
    const sw = await pick(p, 2);
    expect(sw.statusCode, sw.body).toBe(200);
    expect(sw.json<SkillsResponse>()).toMatchObject({ activePreset: 2, inForce: rend });
    expect((await pick(p, 2)).statusCode).toBe(200);
    expect(await audits(p.hero.id, 'skills.loadout_switch')).toHaveLength(1);
    expect((await pick(p, 3)).json<SkillsResponse>()).toMatchObject({
      activePreset: 3,
      inForce: { actives: ['heavyStrike', null, null], passive: null },
    });
    expect((await pick(p, 0)).statusCode).toBe(400);
    const rows = [
      ...(await db()
        .select()
        .from(telemetryDaily)
        .where(eq(telemetryDaily.metric, 'skills.loadout'))),
      ...(await db()
        .select()
        .from(telemetryDailyTest)
        .where(eq(telemetryDailyTest.metric, 'skills.loadout'))),
    ];
    const dims = rows.map((r) => [r.dim1, r.dim2, r.dim3]);
    expect(dims).toContainEqual(['warrior', 'rend+execute+-:berserker', 'switch']);
    expect(dims).toContainEqual(['warrior', 'default', 'switch']);
  });

  it('a stored loadout the hero can no longer field fights as the default (never trusted)', async () => {
    const p = await hero('warrior', 30);
    await db()
      .insert(characterLoadouts)
      .values({
        characterId: p.hero.id,
        preset: 1,
        actives: ['heavyStrike', 'earthsplitter', null],
        passive: null,
      });
    const s = (await skills(p)).json<SkillsResponse>();
    expect(s.presets[0]!.problems).toEqual(['earthsplitter is locked']);
    expect(s.inForce).toEqual({ actives: ['heavyStrike', null, null], passive: null });
  });
});

describe('Soul Fragments are stored with the activity (owner decision 8)', () => {
  it('carry across settlements, wait with the hero when it stops, and come back', async () => {
    const p = await hero('warlock', 20);
    const l: Loadout = { actives: ['agony', 'corruption', 'soulBurn'], passive: 'darkPact' };
    expect((await save(p, 1, l)).statusCode).toBe(200);
    expect(
      (await call(p.who, 'POST', `/characters/${p.hero.id}/activity`, { areaId: 'sunkenAbbey' }))
        .statusCode,
    ).toBeLessThan(300);
    for (let k = 0; k < 3; k++) {
      nowMs += 15 * MIN;
      const w = await predict(p.hero.id, 15 * MIN, l);
      expect(
        (await call(p.who, 'POST', `/characters/${p.hero.id}/activity/settle`)).statusCode,
      ).toBe(200);
      expect((await activityOf(p.hero.id)).soulFragments).toBe(w.result.soulFragments ?? 0);
    }
    const held = (await activityOf(p.hero.id)).soulFragments;
    expect((await skills(p)).json<SkillsResponse>().soulFragments).toBe(held);
    expect((await call(p.who, 'POST', `/characters/${p.hero.id}/activity/stop`)).statusCode).toBe(
      200,
    );
    const [c] = await db().select().from(characters).where(eq(characters.id, p.hero.id));
    expect(c!.farmState?.soulFragments ?? 0).toBe(held);
    expect(
      (await call(p.who, 'POST', `/characters/${p.hero.id}/activity`, { areaId: 'sunkenAbbey' }))
        .statusCode,
    ).toBeLessThan(300);
    expect((await activityOf(p.hero.id)).soulFragments).toBe(held);
  });
});

describe('the duel defence and Power 4', () => {
  it('the defence snapshot carries the loadout saved with it; Power 4 reads it', async () => {
    const p = await hero('hunter', 30);
    await equipKit(db(), p.hero.id, 'hunter', 29, 'rare', p.who.id);
    const l: Loadout = { actives: ['aimedShot', 'killShot', 'quickShot'], passive: 'skirmisher' };
    expect((await save(p, 1, l)).statusCode).toBe(200);
    const api = arenaCalls(app);
    const set = await api.setDefence(p.who, p.hero.id);
    expect(set.statusCode, set.body).toBe(200);
    const defenceId = set.json<ArenaStateResponse>().defence!.defenceId;
    const [d] = await db().select().from(duelDefences).where(eq(duelDefences.id, defenceId));
    expect(d!.snapshot.loadout).toEqual(l);
    expect(duelFighter(d!.snapshot).loadout).toEqual(l);
    // A later switch does not touch the stored defence until it is refreshed.
    expect((await pick(p, 2)).statusCode).toBe(200);
    const [still] = await db().select().from(duelDefences).where(eq(duelDefences.id, defenceId));
    expect(still!.snapshot.loadout).toEqual(l);
    // Power 4 reads the defence's loadout; versions 1–3 never do.
    const [h] = await db().select().from(characters).where(eq(characters.id, p.hero.id));
    const input = await scoringInput(app, db(), h!);
    expect(input.loadout).toEqual(l);
    const without = { ...input, loadout: null };
    expect(computeScore('power', input, 3)).toEqual(computeScore('power', without, 3));
    // Refreshed on the default loadout: no loadout in the snapshot, and Power 4 = Power 3.
    expect((await api.setDefence(p.who, p.hero.id)).statusCode).toBe(200);
    const [fresh] = await db().select().from(duelDefences).where(eq(duelDefences.id, defenceId));
    expect(fresh!.snapshot.loadout).toBeUndefined();
    const input2 = await scoringInput(app, db(), h!);
    expect(input2.loadout).toBeUndefined();
    expect(computeScore('power', input2, 4).value).toBe(computeScore('power', input2, 3).value);
  });
});

describe('duel rules version 3 takes over between seasons (5.3’s rule)', () => {
  it('a running season fights version 2 to its end; the next duel fights version 3', async () => {
    // Its own database: the plan is made the first time the server sees version 3.
    const fresh = await createTestDatabase();
    let t = START;
    const at = () => new Date(t);
    const app2 = buildApp({
      database: fresh,
      auth: { now: at, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: at },
    });
    try {
      await fresh.db
        .insert(seasons)
        .values([{ number: 1, startsAt: new Date(t - 10 * DAY), endsAt: new Date(t + 2 * DAY) }]);
      await app2.ready();
      const api = arenaCalls(app2);
      const make = async (classId: ClassId) => {
        const who = await insertAccount(fresh.db, { now: at() });
        const h = await insertCharacter(fresh.db, who.id, { classId, level: 24 });
        await equipKit(fresh.db, h.id, classId, 23, 'rare', who.id);
        return { who, hero: h };
      };
      const a = await make('warlock');
      const b = await make('warrior');
      await befriend(fresh.db, a.who.id, b.who.id, 'friends');
      const l: Loadout = { actives: ['agony', 'corruption', 'soulBurn'], passive: null };
      const saveOn = (p: typeof a, preset: number, loadout: Loadout) =>
        app2.inject({
          method: 'PUT',
          url: `/api/characters/${p.hero.id}/skills/presets/${preset}`,
          payload: { actives: loadout.actives, passive: loadout.passive ?? null },
          cookies: { [SESSION_COOKIE]: p.who.token },
        });
      expect((await saveOn(a, 1, l)).statusCode).toBe(200);
      const defence = (await api.setDefence(b.who, b.hero.id)).json<ArenaStateResponse>().defence!
        .defenceId;
      const fight = async () => {
        const res = await api.duel(a.who, a.hero.id, defence, 'friendly');
        expect(res.statusCode, res.body).toBe(201);
        const rows = await fresh.db
          .select()
          .from(duels)
          .where(eq(duels.challengerCharacterId, a.hero.id));
        return rows.sort((x, y) => +x.foughtAt - +y.foughtAt).at(-1)!;
      };
      const during = await fight();
      expect(during.rulesVersion).toBe(2);
      expect(during.challengerSnapshot.loadout).toEqual(l);
      // Version 2 never read the loadout: the replay without it is the same duel.
      const replay = (row: typeof during) =>
        simulateDuel({
          challenger: duelFighter(row.challengerSnapshot),
          defender: duelFighter(row.defenderSnapshot),
          seed: row.seed,
          bracketId: row.bracketId,
          rulesVersion: row.rulesVersion,
        });
      expect(replay(during).events).toEqual(during.events);
      expect(during.events.some((e) => e.type === 'tick')).toBe(false);
      // The season's last moment, then its end.
      t += 2 * DAY - 1;
      expect((await fight()).rulesVersion).toBe(2);
      t += 1;
      const after = await fight();
      expect(after.rulesVersion).toBe(3);
      expect(replay(after).events).toEqual(after.events);
      expect(after.events.some((e) => e.type === 'attack' && e.skillId !== undefined)).toBe(true);
      const planned = (
        await fresh.db.select().from(auditLog).where(eq(auditLog.event, 'arena.rules_schedule'))
      ).length;
      expect(planned).toBe(1);
    } finally {
      await app2.close();
      await fresh.close();
    }
  });
});
