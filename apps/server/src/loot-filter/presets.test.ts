import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  EMPTY_LOOT_FILTER,
  LOOT_FILTER_AFFIX_IDS,
  encodeLootFilterCode,
  type LootFilterRules,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { activities, auditLog, characters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import type { LootFilterResponse } from './routes.js';
import { NAME_SAFE_LETTERS } from '../test/names.js';

/** Ticket 8.5: loot-filter presets and share codes (docs/LOOT.md "Presets and share codes"). */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let database: DatabaseHandle;
let app: FastifyInstance;
// The game clock, derived from the wall clock (CLAUDE.md "Dates").
let nowMs = Date.now();
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
  id: string;
}

let seq = 0;
const tag = () => {
  seq += 1;
  let n = seq;
  let s = '';
  do {
    s = NAME_SAFE_LETTERS[n % NAME_SAFE_LETTERS.length]! + s;
    n = Math.floor(n / NAME_SAFE_LETTERS.length);
  } while (n > 0);
  return s;
};

async function newPlayer(classId = 'hunter'): Promise<Player> {
  const t = tag();
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `preset-${t}@graumark.test`,
      displayName: `Keeper ${t}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Keeper${t}`, classId, appearance: { banner: 'moss' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  return { token, id: created.json<{ character: { id: string } }>().character.id };
}

function call(p: Player, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/characters/${p.id}${path}`,
    ...(payload ? { payload } : {}),
    headers: { 'idempotency-key': randomUUID() },
    cookies: { [SESSION_COOKIE]: p.token },
  });
}

const rules = (r: Partial<LootFilterRules>): LootFilterRules => ({ ...EMPTY_LOOT_FILTER, ...r });

const audits = (p: Player, event: string) =>
  database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, p.id), eq(auditLog.event, event)))
    .orderBy(asc(auditLog.id));
const filterOf = async (p: Player) =>
  (await database.db.select().from(characters).where(eq(characters.id, p.id)))[0]!.lootFilter;

/** A forged code: any payload with a correct checksum (the format is public). */
function forged(payload: string): string {
  const body = Buffer.from(payload, 'ascii').toString('base64url');
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `wf1.${body}.${h.toString(36)}`;
}

const junk = rules({ belowRarity: 'rare', action: 'sell' });
const affixHunt = rules({ wantedAffixes: [LOOT_FILTER_AFFIX_IDS[0]!], include: ['set'] });

describe('loot filter presets (ticket 8.5)', () => {
  it('saves, renames, overwrites and deletes up to five presets without touching the filter', async () => {
    const p = await newPlayer();
    for (let slot = 0; slot < 5; slot++) {
      const res = await call(p, 'POST', '/loot-filter/presets', {
        slot,
        name: `  Set   ${slot} `,
        rules: slot % 2 ? junk : affixHunt,
      });
      expect(res.statusCode).toBe(200);
    }
    const all = (await call(p, 'GET', '/loot-filter')).json<LootFilterResponse>();
    expect(all.rules).toBeNull();
    expect(all.presets.map((x) => x.name)).toEqual(['Set 0', 'Set 1', 'Set 2', 'Set 3', 'Set 4']);
    expect(all.presets[1]).toMatchObject({ slot: 1, rules: junk, active: true });
    expect(await filterOf(p)).toBeNull();

    // No sixth slot, no gaps, names checked.
    expect(
      (await call(p, 'POST', '/loot-filter/presets', { slot: 5, name: 'x', rules: junk }))
        .statusCode,
    ).toBe(400);
    const q = await newPlayer();
    const gap = await call(q, 'POST', '/loot-filter/presets', { slot: 2, name: 'x', rules: junk });
    expect(gap.statusCode).toBe(422);
    expect(gap.json()).toMatchObject({ error: { code: 'preset_slot_gap', details: { next: 0 } } });
    for (const name of ['', '   ', 'x'.repeat(25), 'a\u202eb']) {
      const bad = await call(q, 'POST', '/loot-filter/presets', { slot: 0, name, rules: junk });
      expect(bad.statusCode, JSON.stringify(name)).toBe(400);
    }

    const renamed = await call(p, 'POST', '/loot-filter/presets/1/rename', { name: 'Junk out' });
    expect(renamed.json<LootFilterResponse>().presets[1]!.name).toBe('Junk out');
    expect(
      (await call(p, 'POST', '/loot-filter/presets/1/rename', { name: 'Junk out' })).statusCode,
    ).toBe(200);
    const over = await call(p, 'POST', '/loot-filter/presets', {
      slot: 0,
      name: 'Hunt',
      code: encodeLootFilterCode(junk),
    });
    expect(over.json<LootFilterResponse>().presets[0]).toMatchObject({ name: 'Hunt', rules: junk });
    const gone = await call(p, 'DELETE', '/loot-filter/presets/2');
    expect(gone.json<LootFilterResponse>().presets.map((x) => x.name)).toEqual([
      'Hunt',
      'Junk out',
      'Set 3',
      'Set 4',
    ]);
    expect((await call(p, 'DELETE', '/loot-filter/presets/4')).statusCode).toBe(200);
    expect((await call(p, 'POST', '/loot-filter/presets/4/rename', { name: 'y' })).statusCode).toBe(
      404,
    );

    const trail = await audits(p, 'loot_filter.preset');
    // Five saves, one rename (the repeat changes nothing), one overwrite, one delete.
    expect(trail.map((a) => (a.data as { action: string }).action)).toEqual([
      'save',
      'save',
      'save',
      'save',
      'save',
      'rename',
      'overwrite',
      'delete',
    ]);
    expect(await audits(p, 'loot_filter.update')).toHaveLength(0);
  });

  it('applies a preset after settling with the old rules, audited', async () => {
    const p = await newPlayer();
    await database.db.update(characters).set({ level: 12 }).where(eq(characters.id, p.id));
    await call(p, 'POST', '/loot-filter/presets', { slot: 0, name: 'Junk', rules: junk });
    expect((await call(p, 'POST', '/activity', { areaId: 'oldBurialGrounds' })).statusCode).toBe(
      201,
    );
    await database.db
      .update(activities)
      .set({ seedSecret: 'preset-apply' })
      .where(eq(activities.characterId, p.id));
    advance(HOUR);
    const applied = await call(p, 'POST', '/loot-filter', { preset: 0 });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<LootFilterResponse>()).toMatchObject({ rules: junk, active: true });
    expect(await filterOf(p)).toEqual(junk);
    // The hour farmed before the change was settled first, under no filter.
    const trail = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.characterId, p.id))
      .orderBy(asc(auditLog.id));
    const events = trail.map((a) => a.event);
    const reward = events.indexOf('activity.reward');
    const update = events.indexOf('loot_filter.update');
    expect(reward).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(reward);
    expect(trail[reward]!.data).not.toHaveProperty('filtered');
    expect(trail[update]!.data).toMatchObject({ before: null, after: junk, preset: 0 });
    // Applying it again changes nothing; an empty slot is 404.
    await call(p, 'POST', '/loot-filter', { preset: 0 });
    expect(await audits(p, 'loot_filter.update')).toHaveLength(1);
    expect((await call(p, 'POST', '/loot-filter', { preset: 3 })).statusCode).toBe(404);
  });

  it('imports a share code, validated on the server', async () => {
    const p = await newPlayer();
    const code = encodeLootFilterCode(affixHunt);
    const preview = await call(p, 'POST', '/loot-filter/decode', { code });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ rules: affixHunt, active: true });
    // The preview writes nothing.
    expect(await filterOf(p)).toBeNull();
    expect(await audits(p, 'loot_filter.update')).toHaveLength(0);

    const set = await call(p, 'POST', '/loot-filter', { code: `  ${code} ` });
    expect(set.statusCode).toBe(200);
    expect(await filterOf(p)).toEqual(affixHunt);
    const [audit] = await audits(p, 'loot_filter.update');
    expect(audit!.data).toMatchObject({ after: affixHunt, via: 'code' });
  });

  it('refuses invalid and malicious codes, changing nothing', async () => {
    const p = await newPlayer();
    await call(p, 'POST', '/loot-filter', { rules: junk });
    const cases: [string, string][] = [
      ['hello', 'malformed'],
      [encodeLootFilterCode(junk).replace(/^wf1/, 'wf2'), 'version'],
      [encodeLootFilterCode(junk).slice(0, -1) + 'q', 'checksum'],
      [forged('s||not-an-affix||'), 'invalid'],
      [forged('s|godly|||'), 'invalid'],
      [forged('s||__proto__||'), 'malformed'],
      [forged('s|rare|||lmsvpz'), 'malformed'],
      [
        forged(`s||${Array.from({ length: 17 }, () => LOOT_FILTER_AFFIX_IDS[0]).join(',')}||`),
        'invalid',
      ],
    ];
    for (const [code, reason] of cases) {
      for (const path of ['/loot-filter', '/loot-filter/decode']) {
        const res = await call(p, 'POST', path, { code });
        expect(res.statusCode, `${path} ${code}`).toBe(400);
        expect(res.json(), code).toMatchObject({
          error: { code: 'invalid_filter_code', details: { reason } },
        });
      }
      const save = await call(p, 'POST', '/loot-filter/presets', { slot: 0, name: 'x', code });
      expect(save.statusCode).toBe(400);
    }
    // Too long, not a string, two sources at once: refused by the schema.
    for (const body of [
      { code: 'wf1.' + 'A'.repeat(5000) + '.1' },
      { code: 7 },
      { code: encodeLootFilterCode(junk), rules: junk },
      { code: encodeLootFilterCode(junk), preset: 0 },
      {},
    ]) {
      expect((await call(p, 'POST', '/loot-filter', body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
    expect(await filterOf(p)).toEqual(junk);
    expect(await audits(p, 'loot_filter.update')).toHaveLength(1);
    expect((await call(p, 'GET', '/loot-filter')).json<LootFilterResponse>().presets).toEqual([]);
  });

  it("never reads or writes another account's presets", async () => {
    const owner = await newPlayer();
    const other = await newPlayer();
    await call(owner, 'POST', '/loot-filter/presets', { slot: 0, name: 'Mine', rules: junk });
    const intruder = { token: other.token, id: owner.id };
    expect((await call(intruder, 'GET', '/loot-filter')).statusCode).toBe(404);
    expect((await call(intruder, 'POST', '/loot-filter', { preset: 0 })).statusCode).toBe(404);
    expect(
      (await call(intruder, 'POST', '/loot-filter/presets', { slot: 1, name: 'x', rules: junk }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(intruder, 'POST', '/loot-filter/presets/0/rename', { name: 'x' })).statusCode,
    ).toBe(404);
    expect((await call(intruder, 'DELETE', '/loot-filter/presets/0')).statusCode).toBe(404);
    const mine = (await call(owner, 'GET', '/loot-filter')).json<LootFilterResponse>();
    expect(mine.presets).toEqual([{ slot: 0, name: 'Mine', rules: junk, active: true }]);
    expect(mine.rules).toBeNull();
  });
});
