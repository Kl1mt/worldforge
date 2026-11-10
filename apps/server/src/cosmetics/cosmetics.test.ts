/**
 * Ticket 6.8: the collection book (docs/COSMETICS.md). Grants exactly once from every source
 * (achievements, milestones, season honours), the backfill (idempotent, resumable), equip
 * validation (only owned ids of the slot's kind, per hero or per account, Idempotency-Key, audit),
 * display privacy (5.2's rules), and invariance (cosmetics change no score or gameplay row).
 * Dates derive from the wall clock (CLAUDE.md "Dates").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { COSMETICS } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accountAchievements,
  accounts,
  auditLog,
  blocks,
  characters,
  cosmeticDisplays,
  cosmeticUnlocks,
  dataBackfills,
  heroAppearances,
  seasonStandings,
  seasons,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertGuild } from '../test/guilds.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { awardAchievements, refreshAchievements } from '../achievements/award.js';
import { awardSeason, prestigeFor } from '../seasons/model.js';
import { arenaPeople } from '../arena/model.js';
import { COSMETIC_BACKFILL_ID, backfillCosmetics } from './backfill.js';
import { grantCosmeticsTx } from './grant.js';

const DAY = 86_400_000;
const NOW = new Date(Date.now() + DAY);

let database: DatabaseHandle;
let app: ReturnType<typeof buildApp>;
let call: ReturnType<typeof caller>;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => NOW;
  app = buildApp({ database, auth: { now }, activity: { ...DEFAULT_ACTIVITY_OPTIONS, now } });
  await app.ready();
  call = caller(app);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

async function unlocks(accountId: string) {
  const rows = await db()
    .select({ id: cosmeticUnlocks.cosmeticId, source: cosmeticUnlocks.source })
    .from(cosmeticUnlocks)
    .where(eq(cosmeticUnlocks.accountId, accountId));
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function grantAudits(accountId: string) {
  const rows = await db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'cosmetic.grant')));
  return rows.map((r) => String(r.data.cosmeticId)).sort();
}

function post(who: TestAccount, url: string, payload: object, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    cookies: { wf_session: who.token },
    headers: key ? { 'idempotency-key': key } : {},
  });
}

describe('granting: exactly once, from the source events', () => {
  it('an achievement brings its cosmetic once, however often it is refreshed', async () => {
    const a = await insertAccount(db());
    const hero = await insertCharacter(db(), a.id, { level: 12 });
    await insertItem(db(), hero.id, { rarityId: 'legendary' });
    for (let i = 0; i < 3; i += 1) {
      await withTransaction(db(), (tx) => refreshAchievements(tx, hero, ['maxRarity'], NOW));
    }
    expect(await unlocks(a.id)).toEqual([
      { id: 'title-colour.ember', source: 'achievement:firstLegendary' },
    ]);
    expect(await grantAudits(a.id)).toEqual(['title-colour.ember']);
  });

  it('milestones come from the hero: level 40, the Tyrant, the Warden, the Heroic crypt', async () => {
    const a = await insertAccount(db());
    const low = await insertCharacter(db(), a.id, { level: 39 });
    await withTransaction(db(), (tx) => refreshAchievements(tx, low, ['maxCharacterLevel'], NOW));
    expect(await unlocks(a.id)).toEqual([]);
    const high = await insertCharacter(db(), a.id, {
      level: 40,
      progress: {
        gravewardenDefeated: true,
        cryptTierCleared: 4,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
      },
    });
    await withTransaction(db(), (tx) => refreshAchievements(tx, high, ['maxCharacterLevel'], NOW));
    await withTransaction(db(), (tx) => refreshAchievements(tx, high, ['maxCharacterLevel'], NOW));
    const ids = (await unlocks(a.id)).map((u) => u.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'appearance.ashen',
        'appearance.ember',
        'appearance.midnight',
        'banner.warden-flame',
      ]),
    );
    expect(new Set(await grantAudits(a.id)).size).toBe((await grantAudits(a.id)).length);
  });

  it('Forgeward contributors get the Forgeward banner with the achievement', async () => {
    const a = await insertAccount(db());
    await withTransaction(db(), (tx) =>
      awardAchievements(
        tx,
        { accountId: a.id, characterId: null, now: NOW, source: 'live' },
        { communityProjects: ['forgewardOutpost'] },
      ),
    );
    expect(await unlocks(a.id)).toEqual([
      { id: 'banner.forgeward', source: 'achievement:forgewardBuilder' },
    ]);
  });

  it('season honours: laurel for any, gilt for Exalted or better, royal for the Champion', async () => {
    const people = await Promise.all([1, 2, 3, 4, 5].map(() => insertAccount(db())));
    const heroes = await Promise.all(people.map((p) => insertCharacter(db(), p.id, { level: 20 })));
    const number = 900 + Math.floor(Math.random() * 99);
    await db()
      .insert(seasons)
      .values({
        number,
        startsAt: new Date(NOW.getTime() - 30 * DAY),
        endsAt: new Date(NOW.getTime() - DAY),
        archivedAt: NOW,
      });
    await db()
      .insert(seasonStandings)
      .values(
        heroes.map((h, i) => ({
          season: number,
          metric: 'level' as const,
          rank: i + 1,
          characterId: h.id,
          accountId: h.accountId,
          classId: h.classId,
          level: 20,
          formulaVersion: 1,
          value: 100 - i,
          sortKey: [100 - i],
          achievedAt: NOW,
        })),
      );
    const out = await awardSeason(db(), number, NOW);
    expect(out.kind).toBe('awarded');
    const got = await Promise.all(people.map(async (p) => (await unlocks(p.id)).map((u) => u.id)));
    expect(got[0]).toEqual(['banner.season-laurel', 'crest.gilt', 'title-colour.royal']);
    expect(got[1]).toEqual(['banner.season-laurel', 'crest.gilt']);
    expect(got[2]).toEqual(['banner.season-laurel', 'crest.gilt']);
    expect(got[3]).toEqual(['banner.season-laurel']);
    expect(got[4]).toEqual(['banner.season-laurel']);
    expect((await unlocks(people[0]!.id))[0]!.source).toBe(`season:${number}`);
    // A second run changes nothing.
    expect((await awardSeason(db(), number, NOW)).kind).toBe('already');
  });

  it('never stores the default appearance or an unknown id', async () => {
    const a = await insertAccount(db());
    const got = await withTransaction(db(), (tx) =>
      grantCosmeticsTx(tx, { accountId: a.id, now: NOW, source: 'test' }, [
        'appearance.default',
        'banner.nope',
      ]),
    );
    expect(got).toEqual([]);
    expect(await unlocks(a.id)).toEqual([]);
  });
});

describe('the backfill', () => {
  it('grants what existing accounts earned, once, and resumes after a crash', async () => {
    // A fresh database so the run covers a known set of accounts.
    const own = await createTestDatabase();
    try {
      const odb = own.db;
      const vet = await insertAccount(odb);
      // Earned before 6.8: the achievement row exists, its cosmetic does not.
      await odb.insert(accountAchievements).values({
        accountId: vet.id,
        achievementId: 'forgewardBuilder',
        characterId: null,
        source: 'live',
        awardedAt: new Date(NOW.getTime() - 10 * DAY),
      });
      await insertCharacter(odb, vet.id, {
        level: 41,
        progress: { gravewardenDefeated: true, forgeTyrantDefeated: true },
      });
      const others = await Promise.all([1, 2, 3].map(() => insertAccount(odb)));
      for (const o of others) await insertCharacter(odb, o.id, { level: 40 });
      const newbie = await insertAccount(odb);
      await insertCharacter(odb, newbie.id, { level: 3 });

      // Crash after two accounts, then resume.
      await expect(
        backfillCosmetics(odb, { now: () => NOW, failAfterAccounts: 2 }),
      ).rejects.toThrow(/stopped/);
      const [none] = await odb
        .select()
        .from(dataBackfills)
        .where(eq(dataBackfills.id, COSMETIC_BACKFILL_ID));
      expect(none).toBeUndefined();
      const first = await backfillCosmetics(odb, { now: () => NOW, batch: 2 });
      expect(first.ran).toBe(true);
      expect(first.accounts).toBe(5);
      const again = await backfillCosmetics(odb, { now: () => NOW });
      expect(again).toEqual({ id: COSMETIC_BACKFILL_ID, ran: false, accounts: 0, granted: 0 });
      const forced = await backfillCosmetics(odb, { now: () => NOW, force: true });
      expect(forced.granted).toBe(0);

      const rows = await odb.select().from(cosmeticUnlocks);
      const of = (id: string) =>
        rows
          .filter((r) => r.accountId === id)
          .map((r) => r.cosmeticId)
          .sort();
      expect(of(vet.id)).toEqual(['appearance.ashen', 'appearance.ember', 'banner.forgeward']);
      for (const o of others) expect(of(o.id)).toEqual(['appearance.ashen']);
      expect(of(newbie.id)).toEqual([]);
      expect(rows.find((r) => r.cosmeticId === 'banner.forgeward')!.source).toBe(
        'backfill:achievement:forgewardBuilder',
      );
      // One audit row per grant, crash or not.
      const [audits] = await odb
        .execute<{ n: number }>(
          sql`select count(*)::int as n from audit_log where event = 'cosmetic.grant'`,
        )
        .then((r) => r.rows);
      expect(Number(audits!.n)).toBe(rows.length);
    } finally {
      await own.close();
    }
  });

  it('hashes the catalogue: a new or moved cosmetic runs it again', () => {
    expect(COSMETIC_BACKFILL_ID).toMatch(/^cosmetics:[0-9a-f]{16}$/);
  });
});

describe('equip and the book', () => {
  it('lists every cosmetic, owned or not, with its source', async () => {
    const a = await insertAccount(db());
    await insertCharacter(db(), a.id);
    const res = await call(a, 'GET', '/api/account/collection');
    expect(res.statusCode, res.body).toBe(200);
    const book = res.json<{
      entries: { id: string; owned: boolean; source: { kind: string } }[];
      heroes: { palette: string | null }[];
      equipped: Record<string, string | null>;
    }>();
    expect(book.entries.map((e) => e.id)).toEqual(COSMETICS.map((c) => c.id));
    expect(book.entries.filter((e) => e.owned).map((e) => e.id)).toEqual(['appearance.default']);
    expect(book.heroes).toEqual([expect.objectContaining({ palette: null })]);
    expect(book.equipped).toEqual({
      banner: null,
      crest: null,
      titleColour: null,
      cosmeticTitle: null,
    });
    expect((await call(null, 'GET', '/api/account/collection')).statusCode).toBe(401);
  });

  it('equips only owned ids of the slot’s kind, needs a key, replays and audits', async () => {
    const a = await insertAccount(db());
    const hero = await insertCharacter(db(), a.id);
    await withTransaction(db(), (tx) =>
      grantCosmeticsTx(tx, { accountId: a.id, now: NOW, source: 'test' }, [
        'banner.forgeward',
        'crest.iron',
        'title-colour.ember',
        'appearance.ember',
      ]),
    );
    expect(
      (await post(a, '/api/account/cosmetics/equip', { banner: 'banner.forgeward' }, null))
        .statusCode,
    ).toBe(400);
    const notOwned = await post(a, '/api/account/cosmetics/equip', { banner: 'banner.crypt-seal' });
    expect(notOwned.statusCode).toBe(422);
    expect(notOwned.json().error.code).toBe('not_owned');
    const wrong = await post(a, '/api/account/cosmetics/equip', { banner: 'crest.iron' });
    expect(wrong.json().error.code).toBe('wrong_kind');
    const unknown = await post(a, '/api/account/cosmetics/equip', { crest: 'crest.diamond' });
    expect(unknown.json().error.code).toBe('unknown_cosmetic');
    expect((await post(a, '/api/account/cosmetics/equip', {})).statusCode).toBe(400);
    expect((await post(a, '/api/account/cosmetics/equip', { pet: 'x' })).statusCode).toBe(400);

    const key = randomUUID();
    const body = {
      banner: 'banner.forgeward',
      crest: 'crest.iron',
      titleColour: 'title-colour.ember',
    };
    const ok = await post(a, '/api/account/cosmetics/equip', body, key);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().equipped).toEqual({ ...body, cosmeticTitle: null });
    const replay = await post(a, '/api/account/cosmetics/equip', body, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    // Partial change keeps the other slots; null = plain.
    const partial = await post(a, '/api/account/cosmetics/equip', { crest: null });
    expect(partial.json().equipped).toEqual({ ...body, crest: null, cosmeticTitle: null });

    // Per hero: an owned appearance, the default, and refusals.
    const url = `/api/characters/${hero.id}/appearance`;
    expect((await post(a, url, { appearance: 'appearance.midnight' })).json().error.code).toBe(
      'not_owned',
    );
    expect((await post(a, url, { appearance: 'banner.forgeward' })).json().error.code).toBe(
      'wrong_kind',
    );
    const worn = await post(a, url, { appearance: 'appearance.ember' });
    expect(worn.statusCode, worn.body).toBe(200);
    expect(worn.json().heroes).toEqual([
      expect.objectContaining({ id: hero.id, palette: 'appearance.ember' }),
    ]);
    const back = await post(a, url, { appearance: 'appearance.default' });
    expect(back.json().heroes[0].palette).toBeNull();
    expect(
      await db().select().from(heroAppearances).where(eq(heroAppearances.characterId, hero.id)),
    ).toEqual([]);

    // Another account's hero: not found (never touched).
    const b = await insertAccount(db());
    await withTransaction(db(), (tx) =>
      grantCosmeticsTx(tx, { accountId: b.id, now: NOW, source: 'test' }, ['appearance.ember']),
    );
    expect((await post(b, url, { appearance: 'appearance.ember' })).statusCode).toBe(404);

    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, a.id), eq(auditLog.event, 'cosmetic.equip')));
    expect(audits.length).toBe(4); // equip, partial, ember, default (the replay wrote nothing)
  });

  it('the database refuses an unowned id even past the route (foreign keys)', async () => {
    const a = await insertAccount(db());
    await expect(
      db()
        .insert(cosmeticDisplays)
        .values({ accountId: a.id, banner: 'banner.forgeward', updatedAt: NOW }),
    ).rejects.toThrow();
  });
});

describe('display privacy (5.2) and where it shows', () => {
  it('boards, profiles and rosters carry the account’s look; a blocked member shows none', async () => {
    const owner = await insertAccount(db());
    const mate = await insertAccount(db());
    await insertCharacter(db(), owner.id);
    await insertCharacter(db(), mate.id);
    await withTransaction(db(), (tx) =>
      grantCosmeticsTx(tx, { accountId: owner.id, now: NOW, source: 'test' }, [
        'banner.forgeward',
        'title-colour.ember',
      ]),
    );
    await post(owner, '/api/account/cosmetics/equip', {
      banner: 'banner.forgeward',
      titleColour: 'title-colour.ember',
    });
    const shown = (await prestigeFor(db(), [owner.id])).get(owner.id)!;
    expect(shown).toMatchObject({
      banner: 'banner.forgeward',
      titleColour: 'title-colour.ember',
      crest: null,
    });

    const profile = await call(mate, 'GET', `/api/players/${owner.handle}/profile`);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().profile.prestige).toMatchObject({ banner: 'banner.forgeward' });

    await insertGuild(db(), mate.id, { members: [{ accountId: owner.id }] });
    const roster = async () => {
      const r = await call(mate, 'GET', '/api/guild');
      expect(r.statusCode, r.body).toBe(200);
      return r
        .json<{ guild: { members: { handle: string; prestige: Record<string, unknown> }[] } }>()
        .guild.members.find((m) => m.handle === owner.handle)!.prestige;
    };
    expect(await roster()).toMatchObject({
      banner: 'banner.forgeward',
      titleColour: 'title-colour.ember',
    });
    await db().insert(blocks).values({ blockerId: mate.id, blockedId: owner.id });
    expect(await roster()).toMatchObject({ banner: null, titleColour: null });
  });

  it('a hero’s palette shows only where its name does (hidden profiles, strangers)', async () => {
    const owner = await insertAccount(db());
    const viewer = await insertAccount(db());
    const hero = await insertCharacter(db(), owner.id);
    await withTransaction(db(), (tx) =>
      grantCosmeticsTx(tx, { accountId: owner.id, now: NOW, source: 'test' }, ['appearance.ember']),
    );
    await post(owner, `/api/characters/${hero.id}/appearance`, { appearance: 'appearance.ember' });
    const seen = async (viewerId: string) =>
      (await arenaPeople(db(), viewerId, [owner.id], [hero.id], NOW)).hero(owner.id, hero.id, {
        name: hero.name,
        classId: hero.classId,
        level: hero.level,
      });
    expect(await seen(viewer.id)).toMatchObject({ name: hero.name, palette: 'appearance.ember' });
    await db()
      .update(accounts)
      .set({ profileVisibility: 'hidden' })
      .where(eq(accounts.id, owner.id));
    expect(await seen(viewer.id)).toMatchObject({ name: null, palette: null });
    expect(await seen(owner.id)).toMatchObject({ palette: 'appearance.ember' });
    expect((await call(viewer, 'GET', `/api/players/${owner.handle}/profile`)).statusCode).toBe(
      404,
    );
  });
});

describe('invariance: cosmetics carry no power', () => {
  it('equipping every cosmetic changes no score and no gameplay row', async () => {
    const a = await insertAccount(db());
    const hero = await insertCharacter(db(), a.id, { level: 30 });
    await insertItem(db(), hero.id, { rarityId: 'epic', equippedSlot: 'mainHand' });
    const scores = async () => {
      const r = await call(a, 'GET', `/api/characters/${hero.id}/scores`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    const row = async () => {
      const [c] = await db().select().from(characters).where(eq(characters.id, hero.id));
      return c;
    };
    const before = { scores: await scores(), row: await row() };
    await withTransaction(db(), (tx) =>
      grantCosmeticsTx(
        tx,
        { accountId: a.id, now: NOW, source: 'test' },
        COSMETICS.map((c) => c.id),
      ),
    );
    await post(a, '/api/account/cosmetics/equip', {
      banner: 'banner.season-laurel',
      crest: 'crest.gilt',
      titleColour: 'title-colour.royal',
    });
    await post(a, `/api/characters/${hero.id}/appearance`, { appearance: 'appearance.midnight' });
    expect(await scores()).toEqual(before.scores);
    expect(await row()).toEqual(before.row);
  });

  it('nothing in the game rules reads the cosmetics module', () => {
    const root = join(import.meta.dirname, '../../../../packages/game-core/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(root);
    const importers = files
      .filter((p) =>
        /from '(\.\.\/)+cosmetics\/|from '\.\/cosmetics\//.test(readFileSync(p, 'utf8')),
      )
      .map((p) => p.slice(root.length + 1))
      .sort();
    // Only the package's index re-exports it.
    expect(importers).toEqual(['index.ts']);
  });
});
