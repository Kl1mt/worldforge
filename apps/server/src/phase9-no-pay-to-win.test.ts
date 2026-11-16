/**
 * Ticket 9.6: the Phase 9 exit criterion's "free of pay-to-win" half (docs/BALANCE.md "Phase 9 exit
 * criterion"). The owner may later sell extra character slots and Shrine draws in the 8.8 shop
 * (decision 2026-11-12), never anything with power; the offline cap is never sold. Phase 9 sells
 * nothing, so these tests write the rows a shop would write (a `shop` slot grant, `shop` draws) and
 * check that none of them moves a number a rule reads.
 *
 * 1. The import scan: no power rule on the server (scores, boards, the arena, combat settlement,
 *    dungeons, the guild boss, skills) reads the Shrine or the account-growth grants, except the
 *    settlement's offline cap (earned deeds only, F3) and hero creation's slot count.
 * 2. Invariance: a hero on a chosen loadout, saved with its duel defence (what Power 4 reads), has
 *    the same scores, defence snapshot and bracket Power before and after its account gets a shop
 *    slot and a hero in it, shop draws drawn, every cosmetic owned and a companion worn.
 * 3. A hero made in a bought slot starts as every hero does: level 1, the starting purse, the
 *    default loadout, and the scores of any fresh hero of its class.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { COSMETICS, type Loadout } from '@worldforge/game-core';
import { buildApp } from './app.js';
import { SESSION_COOKIE } from './auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from './activity/settle.js';
import {
  accountGrowthGrants,
  accounts,
  characters,
  cosmeticUnlocks,
  duelDefences,
  shrineDrawGrants,
} from './db/schema.js';
import type { DatabaseHandle } from './db/types.js';
import { createTestDatabase } from './test/db.js';
import { equipKit } from './test/arena.js';
import { insertCharacter } from './test/heroes.js';
import { insertAccount, type TestAccount } from './test/social.js';

const SERVER = import.meta.dirname;

function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function importersOf(root: string, m: string, within: (rel: string) => boolean): string[] {
  const re = new RegExp(`from '(\\.\\./)+${m}/|from '\\./${m}/`);
  return sources(root)
    .map((p) => p.slice(root.length + 1))
    .filter(within)
    .filter((rel) => re.test(readFileSync(join(root, rel), 'utf8')))
    .sort();
}

describe('Phase 9: no pay-to-win (ticket 9.6)', () => {
  it('no power rule reads the Shrine; the grants are read only for the cap and the slot count (import scan)', () => {
    const power = (rel: string) =>
      /^(scores|leaderboards|arena|activity|dungeon|guild-boss|skills|quests)\//.test(rel);
    expect(importersOf(SERVER, 'shrine', power)).toEqual([]);
    // The settlement reads the earned offline deeds (never a shop grant: F3), and the farming
    // screen shows the same cap.
    expect(importersOf(SERVER, 'account-growth', power)).toEqual([
      'activity/routes.ts',
      'activity/settle.ts',
    ]);
    expect(readFileSync(join(SERVER, 'activity/settle.ts'), 'utf8')).toMatch(
      /import \{ offlineCapEndTx \} from '\.\.\/account-growth\/grant\.js';/,
    );
  });

  describe('invariance', () => {
    let database: DatabaseHandle;
    let app: FastifyInstance;
    const nowMs = Date.now();
    beforeAll(async () => {
      database = await createTestDatabase();
      app = buildApp({
        database,
        auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
        activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
    });

    const call = (
      who: TestAccount,
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      payload?: object,
    ) =>
      app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: who.token },
      });

    it('a shop slot and its hero, shop draws, every cosmetic and a companion: the same hero on its loadout', async () => {
      const db = database.db;
      const me = await insertAccount(db);
      const hero = await insertCharacter(db, me.id, { level: 30, classId: 'warlock' });
      await db.update(accounts).set({ activeCharacterId: hero.id }).where(eq(accounts.id, me.id));
      await equipKit(db, hero.id, 'warlock', 29, 'legendary', 'p2w9');
      const base = `/api/characters/${hero.id}`;
      const shadow: Loadout = { actives: ['agony', 'corruption', 'soulBurn'], passive: 'malice' };
      const saved = await call(me, 'PUT', `${base}/skills/presets/1`, shadow);
      expect(saved.statusCode, saved.body).toBe(200);

      const measure = async () => {
        const defence = await call(me, 'POST', '/api/arena/defence', { characterId: hero.id });
        expect(defence.statusCode, defence.body).toBe(200);
        const scores = await call(me, 'GET', `${base}/scores`);
        expect(scores.statusCode, scores.body).toBe(200);
        const skills = await call(me, 'GET', `${base}/skills`);
        const [d] = await db
          .select()
          .from(duelDefences)
          .where(eq(duelDefences.characterId, hero.id));
        return {
          scores: scores.json<{ scores: unknown }>().scores,
          inForce: skills.json<{ inForce: unknown }>().inForce,
          power: d!.power,
          bracket: d!.bracketId,
          snapshot: { ...d!.snapshot, appearance: undefined, looks: undefined },
        };
      };
      const before = await measure();
      expect(before.snapshot.loadout).toEqual(shadow);

      // What a later shop would write: a slot and draws, each recorded with source `shop`.
      await db.insert(accountGrowthGrants).values({
        accountId: me.id,
        grantId: 'shop:slot-1',
        kind: 'slot',
        source: 'shop',
        characterId: null,
        backfill: false,
        grantedAt: new Date(nowMs),
      });
      await db.insert(shrineDrawGrants).values({
        accountId: me.id,
        source: 'shop',
        sourceKey: 'shop:order-1',
        count: 3,
        characterId: null,
        grantedAt: new Date(nowMs),
      });
      // A hero in the third slot (the base two are the hero above and this one's predecessor).
      const made = [] as string[];
      for (const name of ['Shopwen', 'Shopric']) {
        const res = await call(me, 'POST', '/api/characters', {
          name,
          classId: 'warlock',
          appearance: { banner: 'ash' },
        });
        expect(res.statusCode, res.body).toBe(201);
        made.push(res.json<{ character: { id: string } }>().character.id);
      }
      await db.update(accounts).set({ activeCharacterId: hero.id }).where(eq(accounts.id, me.id));
      // Shop draws are drawn like any other (every pool cosmetic owned below would make marks;
      // here they grant or mark by their seed, both cosmetic).
      for (let i = 0; i < 3; i++) {
        const drew = await call(me, 'POST', '/api/account/shrine/draw');
        expect(drew.statusCode, drew.body).toBe(200);
      }
      await db
        .insert(cosmeticUnlocks)
        .values(
          COSMETICS.map((c) => ({
            accountId: me.id,
            cosmeticId: c.id,
            source: 'test:p2w9',
            grantedAt: new Date(nowMs),
          })),
        )
        .onConflictDoNothing();
      const companion = COSMETICS.find((c) => c.kind === 'companion')!.id;
      const worn = await call(me, 'POST', '/api/account/cosmetics/equip', { companion });
      expect(worn.statusCode, worn.body).toBe(200);

      expect(await measure()).toEqual(before);

      // The bought slot's hero is a fresh hero: level 1, the default loadout, a fresh hero's scores.
      const other = await insertAccount(db);
      const fresh = await call(other, 'POST', '/api/characters', {
        name: 'Freshwyn',
        classId: 'warlock',
        appearance: { banner: 'ash' },
      });
      const freshId = fresh.json<{ character: { id: string } }>().character.id;
      const view = async (who: TestAccount, id: string) => {
        const [row] = await db.select().from(characters).where(eq(characters.id, id));
        const scores = await call(who, 'GET', `/api/characters/${id}/scores`);
        const skills = await call(who, 'GET', `/api/characters/${id}/skills`);
        return {
          level: row!.level,
          experience: row!.experience,
          gold: row!.gold,
          progress: row!.progress,
          scores: scores.json<{ scores: unknown }>().scores,
          inForce: skills.json<{ inForce: unknown }>().inForce,
        };
      };
      const shopHero = await view(me, made[1]!);
      expect(shopHero.level).toBe(1);
      expect(shopHero).toEqual(await view(other, freshId));
    });
  });
});
