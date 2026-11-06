import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  MAX_SHOWN_ACHIEVEMENTS,
  PROFILE_VISIBILITIES,
  canViewProfile,
  type ProfileRelation,
  type ProfileVisibility,
  type Relation,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { accountAchievements, accounts, auditLog, sanctions } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { refreshAchievements } from '../achievements/award.js';
import { profileRelation } from './profiles.js';
import { relationBetween } from './relations.js';

describe('public profiles (ticket 4.2)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2026-11-06T12:00:00Z');
  const now = () => new Date(nowMs);
  let call: ReturnType<typeof caller>;
  let mod: TestAccount;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 6 }] } },
    });
    await app.ready();
    call = caller(app);
    mod = await insertAccount(db(), { role: 'moderator', now: now() });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  beforeEach(() => {
    nowMs += 10 * 60_000;
  });

  const player = () => insertAccount(db(), { now: now() });
  const profile = (who: TestAccount, handle: string) =>
    call(who, 'GET', `/api/players/${handle}/profile`);
  const save = (who: TestAccount, body: object) => call(who, 'POST', '/api/account/profile', body);
  const setVisibility = (who: TestAccount, visibility: ProfileVisibility) =>
    db().update(accounts).set({ profileVisibility: visibility }).where(eq(accounts.id, who.id));

  async function owner() {
    const acc = await player();
    const hero = await insertCharacter(db(), acc.id, { level: 20 });
    await insertItem(db(), hero.id, { rarityId: 'legendary', equippedSlot: 'weapon' });
    await refreshAchievements(db(), hero, ['maxRarity', 'maxCharacterLevel'], now());
    return { acc, hero };
  }

  describe('privacy: each setting × each viewer relation', () => {
    // The viewer's side of 4.3's relation, set up through 4.3's API; the server maps it onto
    // game-core's `ProfileRelation` and asks `canViewProfile` (guildmates arrive in 4.4).
    const RELATIONS: [Relation, ProfileRelation][] = [
      ['self', 'self'],
      ['stranger', 'stranger'],
      ['requested-by-me', 'pending'],
      ['requested-by-them', 'pending'],
      ['friend', 'friend'],
      ['blocked-by-me', 'blocked'],
      ['blocked-by-them', 'blocked'],
    ];
    const ok = async (p: Promise<{ statusCode: number; body: string }>) => {
      const r = await p;
      expect(r.statusCode, r.body).toBe(200);
    };
    async function viewerWith(owner: TestAccount, relation: Relation): Promise<TestAccount> {
      if (relation === 'self') return owner;
      const viewer = await player();
      const request = (from: TestAccount, to: TestAccount) =>
        ok(call(from, 'POST', '/api/friends/requests', { handle: to.handle }));
      if (relation === 'requested-by-me') await request(viewer, owner);
      if (relation === 'requested-by-them') await request(owner, viewer);
      if (relation === 'friend') {
        await request(viewer, owner);
        await ok(call(owner, 'POST', `/api/friends/requests/${viewer.handle}/accept`));
      }
      if (relation === 'blocked-by-me') {
        await ok(call(viewer, 'POST', '/api/blocks', { handle: owner.handle }));
      }
      if (relation === 'blocked-by-them') {
        await ok(call(owner, 'POST', '/api/blocks', { handle: viewer.handle }));
      }
      expect(await relationBetween(db(), viewer.id, owner.id)).toBe(relation);
      return viewer;
    }

    for (const visibility of PROFILE_VISIBILITIES) {
      for (const [relation, profileRel] of RELATIONS) {
        it(`${visibility} × ${relation}`, async () => {
          const { acc, hero } = await owner();
          await setVisibility(acc, visibility);
          await db()
            .update(accounts)
            .set({ showcaseCharacterId: hero.id })
            .where(eq(accounts.id, acc.id));
          const viewer = await viewerWith(acc, relation);
          expect(await profileRelation(db(), viewer.id, acc.id)).toBe(profileRel);
          const visible = canViewProfile(visibility, profileRel);
          // Blocks hide the profile whatever the setting; friends see "friends and guild".
          if (profileRel === 'blocked') expect(visible).toBe(false);
          if (profileRel === 'friend') expect(visible).toBe(visibility !== 'hidden');
          const byHandle = await profile(viewer, acc.handle);
          const byName = await call(
            viewer,
            'GET',
            `/api/players/lookup?name=${encodeURIComponent(acc.displayName)}`,
          );
          const byLookupHandle = await call(
            viewer,
            'GET',
            `/api/players/lookup?handle=${acc.handle}`,
          );
          const unknown = await profile(viewer, 'zzzzzzzzzzzz');
          const unknownName = await call(viewer, 'GET', '/api/players/lookup?name=Nobody%20Here');
          for (const res of [byHandle, byName, byLookupHandle]) {
            expect(res.statusCode).toBe(visible ? 200 : 404);
          }
          if (!visible) {
            // Indistinguishable from a player who does not exist (profile, showcase and lookup).
            expect(byHandle.json()).toEqual(unknown.json());
            expect(byName.json()).toEqual(unknownName.json());
            expect(byHandle.body).not.toContain(hero.name);
          } else {
            const view = byHandle.json().profile;
            expect(view.self).toBe(relation === 'self');
            expect(view.visibility).toBe(relation === 'self' ? visibility : null);
            expect(view.showcase.name).toBe(hero.name);
          }
        });
      }
    }

    it('needs a session', async () => {
      const { acc } = await owner();
      expect((await profile(null as never, acc.handle)).statusCode).toBe(401);
    });
  });

  it('lookup by handle or name; one of them is required', async () => {
    const { acc } = await owner();
    const viewer = await player();
    const byHandle = await call(viewer, 'GET', `/api/players/lookup?handle=${acc.handle}`);
    expect(byHandle.json()).toEqual({
      player: { handle: acc.handle, displayName: acc.displayName },
    });
    const byName = await call(
      viewer,
      'GET',
      `/api/players/lookup?name=${encodeURIComponent(acc.displayName.toUpperCase())}`,
    );
    expect(byName.json().player.handle).toBe(acc.handle);
    expect((await call(viewer, 'GET', '/api/players/lookup')).statusCode).toBe(400);
  });

  it('shows characters, chosen achievements in order and the showcase, nothing private', async () => {
    const { acc, hero } = await owner();
    const viewer = await player();
    // Before choosing: characters only, no achievements, no showcase.
    let view = (await profile(viewer, acc.handle)).json().profile;
    expect(view.characters).toEqual([
      { name: hero.name, classId: 'warrior', level: 20, appearance: { banner: 'ash' } },
    ]);
    expect(view.achievements).toEqual([]);
    expect(view.showcase).toBeNull();

    const res = await save(acc, {
      visibility: 'public',
      shown: ['level20', 'firstLegendary'],
      showcaseCharacterId: hero.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shown).toEqual(['level20', 'firstLegendary']);
    view = (await profile(viewer, acc.handle)).json().profile;
    expect(view.achievements.map((a: { id: string }) => a.id)).toEqual([
      'level20',
      'firstLegendary',
    ]);
    expect(view.achievements[0].awardedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.showcase.name).toBe(hero.name);
    expect(view.showcase.equipped).toHaveLength(1);
    const item = view.showcase.equipped[0];
    expect(item.slot).toBe('weapon');
    for (const key of ['id', 'seed', 'source', 'createdAt', 'locked', 'forgeSecret']) {
      expect(item).not.toHaveProperty(key);
    }
    const body = JSON.stringify(view);
    expect(body).not.toContain(acc.id);
    expect(body).not.toContain(hero.id);
    expect(body).not.toContain('@graumark.test');

    // Re-ordering and removing keep the slots consistent.
    await save(acc, { visibility: 'public', shown: ['firstLegendary'], showcaseCharacterId: null });
    view = (await profile(viewer, acc.handle)).json().profile;
    expect(view.achievements.map((a: { id: string }) => a.id)).toEqual(['firstLegendary']);
    expect(view.showcase).toBeNull();
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acc.id), eq(auditLog.event, 'profile.update')));
    expect(audits).toHaveLength(2);
  });

  it('refuses unearned or unknown achievements, too many, and other players’ heroes', async () => {
    const { acc } = await owner();
    const other = await owner();
    const bad = async (body: object, status: number, code?: string) => {
      const res = await save(acc, {
        visibility: 'public',
        shown: [],
        showcaseCharacterId: null,
        ...body,
      });
      expect(res.statusCode).toBe(status);
      if (code) expect(res.json().error.code).toBe(code);
    };
    await bad({ shown: ['cryptTier3'] }, 422, 'achievement_not_earned');
    await bad({ shown: ['notAThing'] }, 422, 'achievement_not_earned');
    await bad(
      { shown: Array.from({ length: MAX_SHOWN_ACHIEVEMENTS + 1 }, (_, i) => `a${i}`) },
      400,
    );
    await bad({ shown: ['level10', 'level10'] }, 400);
    nowMs += 10 * 60_000;
    await bad({ showcaseCharacterId: other.hero.id }, 422, 'not_your_character');
    await bad({ visibility: 'friends' }, 400);
    nowMs += 10 * 60_000;
    // The owner's settings view lists every earned achievement.
    const mine = (await call(acc, 'GET', '/api/account/profile')).json();
    expect(mine.earned.map((e: { id: string }) => e.id).sort()).toEqual([
      'firstEpic',
      'firstLegendary',
      'level10',
      'level20',
    ]);
    expect(mine.visibility).toBe('public');
    const rows = await db()
      .select()
      .from(accountAchievements)
      .where(eq(accountAchievements.accountId, acc.id));
    expect(rows.every((r) => r.shownSlot === null)).toBe(true);
  });

  it('is rate limited as a social write, and allowed while muted', async () => {
    const { acc } = await owner();
    await db()
      .insert(sanctions)
      .values({
        id: uuidv7(),
        subjectId: acc.id,
        issuedBy: mod.id,
        kind: 'mute',
        reason: 'Test mute',
        createdAt: now(),
        expiresAt: new Date(nowMs + 3_600_000),
      });
    const body = { visibility: 'hidden', shown: [], showcaseCharacterId: null };
    for (let i = 0; i < 6; i++) expect((await save(acc, body)).statusCode).toBe(200);
    const limited = await save(acc, body);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.details.limit).toBe('social');
  });

  it('reports a character name from the profile; a moderator can hide it', async () => {
    const { acc, hero } = await owner();
    const viewer = await player();
    const res = await call(viewer, 'POST', '/api/reports', {
      target: { kind: 'characterName', handle: acc.handle, name: hero.name.toUpperCase() },
      reason: 'inappropriate',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().report.target).toEqual({
      kind: 'characterName',
      handle: acc.handle,
      name: hero.name,
    });
    const missing = await call(viewer, 'POST', '/api/reports', {
      target: { kind: 'characterName', handle: acc.handle, name: 'Nobody Here' },
      reason: 'inappropriate',
    });
    expect(missing.statusCode).toBe(404);

    const queue = (await call(mod, 'GET', '/api/mod/queue?limit=50')).json();
    const c = queue.cases.find(
      (x: { target: { kind: string; handle: string } }) =>
        x.target.kind === 'characterName' && x.target.handle === acc.handle,
    );
    expect(c.current).toEqual({ value: hero.name, hidden: false });
    const hide = await call(mod, 'POST', `/api/mod/reports/${c.reportId}/resolve`, {
      action: 'hideContent',
      reason: 'Offensive hero name',
      durationHours: 24 * 7,
    });
    expect(hide.statusCode).toBe(200);

    const seen = (await profile(viewer, acc.handle)).json().profile;
    expect(seen.characters[0].name).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(hero.name);
    // The owner still sees their own hero's name.
    expect((await profile(acc, acc.handle)).json().profile.characters[0].name).toBe(hero.name);
  });

  it('a hidden display name is null on the profile and not found by name', async () => {
    const { acc } = await owner();
    const viewer = await player();
    const res = await call(viewer, 'POST', '/api/reports', {
      target: { kind: 'profileField', handle: acc.handle, field: 'displayName' },
      reason: 'inappropriate',
    });
    const queue = (await call(mod, 'GET', '/api/mod/queue?limit=50')).json();
    const c = queue.cases.find(
      (x: { reports: { id: string }[] }) => x.reports[0]!.id === res.json().report.id,
    );
    await call(mod, 'POST', `/api/mod/reports/${c.reportId}/resolve`, {
      action: 'hideContent',
      reason: 'Name',
      durationHours: 24,
    });
    expect((await profile(viewer, acc.handle)).json().profile.displayName).toBeNull();
    const byName = await call(
      viewer,
      'GET',
      `/api/players/lookup?name=${encodeURIComponent(acc.displayName)}`,
    );
    expect(byName.statusCode).toBe(404);
  });
});
