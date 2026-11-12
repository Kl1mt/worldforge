/**
 * Ticket 8.7: the Phase 8 exit criterion's "free of pay-to-win" half (docs/BALANCE.md "Phase 8 exit
 * criterion", game-core `balance/phase8-exit-criterion.test.ts` for the rest).
 *
 * 1. The import scan: no rule that makes a hero stronger (combat, scoring, PvP, loot, dungeons,
 *    items, farming) reads the cosmetics, guild halls, guild seasons or events modules in
 *    game-core; on the server, the scores, the boards and the duel snapshot read them only for
 *    looks.
 * 2. Invariance: a hero's scores, its stored duel defence (snapshot and bracket Power) and its
 *    Gear Score breakdown are the same before and after its account owns and wears every cosmetic
 *    in the catalogue (event keepsakes and guild honours among them) and its guild buys and hangs
 *    every hall upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { COSMETICS, GUILD_HALL_KINDS, GUILD_HALL_UPGRADES } from '@worldforge/game-core';
import { buildApp } from './app.js';
import { SESSION_COOKIE } from './auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from './activity/settle.js';
import { cosmeticUnlocks, duelDefences, guildHallUpgrades } from './db/schema.js';
import type { DatabaseHandle } from './db/types.js';
import { createTestDatabase } from './test/db.js';
import { equipKit } from './test/arena.js';
import { insertGuild } from './test/guilds.js';
import { insertCharacter } from './test/heroes.js';
import { insertAccount, type TestAccount } from './test/social.js';

const GAME_CORE = join(import.meta.dirname, '../../../packages/game-core/src');
const SERVER = import.meta.dirname;
const PHASE8_MODULES = ['cosmetics', 'guild-halls', 'guild-seasons', 'events'] as const;

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

/** Files under `root` that import module `m` (a sibling directory), relative to `root`. */
function importersOf(root: string, m: string, within: (rel: string) => boolean): string[] {
  const re = new RegExp(`from '(\\.\\./)+${m}/|from '\\./${m}/`);
  return sources(root)
    .map((p) => p.slice(root.length + 1))
    .filter(within)
    .filter((rel) => re.test(readFileSync(join(root, rel), 'utf8')))
    .sort();
}

describe('Phase 8: no pay-to-win (ticket 8.7)', () => {
  it('no power rule reads cosmetics, guild halls, guild seasons or events (import scan)', () => {
    const rules = (rel: string) =>
      /^(combat|scoring|pvp|loot|dungeon|items|activity|economy|world|quests|professions)\//.test(
        rel,
      ) || ['stats.ts', 'equipment.ts', 'classes.ts', 'characters.ts'].includes(rel);
    for (const m of PHASE8_MODULES) {
      expect(importersOf(GAME_CORE, m, rules), `game-core rules importing ${m}`).toEqual([]);
    }
    // On the server: the scores, the boards' snapshot and check, and the arena read them only
    // for looks (the duel screen's hero palettes, ticket 6.8).
    const power = (rel: string) => /^(scores|leaderboards|arena)\//.test(rel);
    expect(importersOf(SERVER, 'cosmetics', power)).toEqual(['arena/model.ts']);
    expect(readFileSync(join(SERVER, 'arena/model.ts'), 'utf8')).toMatch(
      /import \{ heroPalettes \} from '\.\.\/cosmetics\/display\.js';/,
    );
    expect(importersOf(SERVER, 'guild-halls', power)).toEqual([]);
    // The board CLI runs the guild roll's recompute check beside the hero boards' (no score).
    expect(importersOf(SERVER, 'guild-seasons', power)).toEqual([
      'leaderboards/leaderboard-cli.ts',
    ]);
    expect(importersOf(SERVER, 'events', power)).toEqual([]);
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

    const call = (who: TestAccount, method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: method === 'POST' ? { 'idempotency-key': randomUUID() } : {},
        cookies: { [SESSION_COOKIE]: who.token },
      });

    it('every cosmetic owned and worn, every hall upgrade bought and hung: the same hero', async () => {
      const db = database.db;
      const me = await insertAccount(db);
      const mate = await insertAccount(db);
      const hero = await insertCharacter(db, me.id, { level: 46, classId: 'hunter' });
      await equipKit(db, hero.id, 'hunter', 45, 'legendary', 'p2w');
      const guild = await insertGuild(db, me.id, { members: [{ accountId: mate.id }] });
      const base = `/api/characters/${hero.id}`;

      const measure = async () => {
        const scores = await call(me, 'GET', `${base}/scores`);
        expect(scores.statusCode, scores.body).toBe(200);
        const defence = await call(me, 'POST', '/api/arena/defence', { characterId: hero.id });
        expect(defence.statusCode, defence.body).toBe(200);
        const [d] = await db
          .select()
          .from(duelDefences)
          .where(eq(duelDefences.characterId, hero.id));
        return {
          scores: scores.json<{ scores: unknown }>().scores,
          power: d!.power,
          bracket: d!.bracketId,
          snapshot: { ...d!.snapshot, appearance: undefined, looks: undefined },
        };
      };
      const before = await measure();
      expect(before.power).toBeGreaterThan(0);
      expect(Object.keys(before.scores as object)).toEqual(
        expect.arrayContaining(['gearScore', 'level', 'power', 'pveProgress']),
      );

      // Every cosmetic in the catalogue (event keepsakes, guild and season honours, deeds), owned…
      await db
        .insert(cosmeticUnlocks)
        .values(
          COSMETICS.map((c) => ({
            accountId: me.id,
            cosmeticId: c.id,
            source: 'test:p2w',
            grantedAt: new Date(nowMs),
          })),
        )
        .onConflictDoNothing();
      // … and worn: one of each kind on the account and the hero.
      const first = (kind: string) => COSMETICS.find((c) => c.kind === kind)!.id;
      const worn = await call(me, 'POST', '/api/account/cosmetics/equip', {
        banner: first('banner'),
        crest: first('crest'),
        titleColour: first('titleColour'),
      });
      expect(worn.statusCode, worn.body).toBe(200);
      const look = await call(me, 'POST', `${base}/appearance`, {
        appearance: first('appearance'),
      });
      expect(look.statusCode, look.body).toBe(200);
      // Every hall upgrade, bought (stored as the treasury's purchase) and one of each kind hung.
      await db.insert(guildHallUpgrades).values(
        GUILD_HALL_UPGRADES.map((u) => ({
          guildId: guild.id,
          upgradeId: u.id,
          boughtBy: me.id,
          gold: u.price.gold,
          materials: u.price.materials,
          boughtAt: new Date(nowMs),
        })),
      );
      const hang = Object.fromEntries(
        GUILD_HALL_KINDS.map((k) => [k, GUILD_HALL_UPGRADES.find((u) => u.kind === k)!.id]),
      );
      const hung = await call(me, 'POST', '/api/guild/hall/display', hang);
      expect(hung.statusCode, hung.body).toBe(200);

      const after = await measure();
      expect(after).toEqual(before);
    });
  });
});
