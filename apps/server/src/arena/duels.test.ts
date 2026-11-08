/**
 * The arena (ticket 5.5, docs/PVP.md "The arena"): defences, the rated opponent list, rated duels
 * and friendly challenges through the API. The permission matrix (relation × kind; the level gate;
 * sanctions; blocks), idempotency (no re-roll by retry or replay), the daily limit at the day
 * boundary (injected clock), snapshots (a defender changing gear changes nothing), invariance (a
 * duel changes nothing anyone owns), privacy of results and history, and the report flow.
 *
 * Never asserts who wins: every outcome is predicted from the stored seed and snapshots with
 * game-core (`simulateDuel`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  DUEL_OFFER_REFRESH_MS,
  DUEL_OFFER_SIZE,
  PVP_RULES_VERSION,
  RATED_DUELS_PER_DAY,
  duelFighter,
  friendlyBracket,
  simulateDuel,
  type ClassId,
  type Relation,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  auditLog,
  characterMaterials,
  characters,
  duelDefences,
  duels,
  itemInstances,
  leaderboardEntries,
  type Character,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { arenaCalls, befriend, block, equipKit, sanction, setOffer } from '../test/arena.js';
import type {
  ArenaStateResponse,
  DuelSummaryView,
  DuelView,
  FriendlyOpponentView,
} from './routes.js';

const START = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60_000;

describe('arena', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let api: ReturnType<typeof arenaCalls>;
  let nowMs = START;
  const now = () => new Date(nowMs);

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    api = arenaCalls(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  beforeEach(() => {
    nowMs = START;
  });

  const db = () => database.db;

  /** An account with one equipped hero. */
  async function player(
    level: number,
    classId: ClassId = 'warrior',
    name?: string,
  ): Promise<{ who: TestAccount; hero: Character }> {
    const who = await insertAccount(db(), { now: now(), ...(name ? { name } : {}) });
    const hero = await insertCharacter(db(), who.id, { classId, level });
    await equipKit(db(), hero.id, classId, Math.max(1, Math.min(29, level - 1)), 'rare', who.id);
    return { who, hero };
  }

  async function defend(p: { who: TestAccount; hero: Character }): Promise<string> {
    const res = await api.setDefence(p.who, p.hero.id);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ArenaStateResponse>().defence!.defenceId;
  }

  const code = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code: string } }).error?.code;

  /** The stored duel row and the duel game-core predicts from its stored seed and snapshots. */
  async function predicted(duelId: string) {
    const [row] = await db().select().from(duels).where(eq(duels.id, duelId));
    const replay = simulateDuel({
      challenger: duelFighter(row!.challengerSnapshot),
      defender: duelFighter(row!.defenderSnapshot),
      seed: row!.seed,
      bracketId: row!.bracketId,
    });
    return { row: row!, replay };
  }

  describe('defence', () => {
    it('stores a snapshot of what the hero wears, shows when, and can be refreshed', async () => {
      const p = await player(14, 'mage');
      const before = await api.state(p.who, p.hero.id);
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json<ArenaStateResponse>().defence).toBeNull();

      const set = await api.setDefence(p.who, p.hero.id);
      expect(set.statusCode, set.body).toBe(200);
      const d = set.json<ArenaStateResponse>().defence!;
      const worn = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, p.hero.id));
      expect(d).toMatchObject({
        heroName: p.hero.name,
        classId: 'mage',
        level: 14,
        bracketId: '10-19',
        setAt: now().toISOString(),
        items: worn.length,
        rejected: [],
        outdated: false,
      });

      // The hero levels up: the defence is outdated until refreshed; the id stays.
      await db().update(characters).set({ level: 16 }).where(eq(characters.id, p.hero.id));
      expect((await api.state(p.who, p.hero.id)).json<ArenaStateResponse>().defence).toMatchObject({
        level: 14,
        outdated: true,
      });
      nowMs += 30 * MIN;
      const again = (await api.setDefence(p.who, p.hero.id)).json<ArenaStateResponse>().defence!;
      expect(again).toMatchObject({
        defenceId: d.defenceId,
        level: 16,
        setAt: now().toISOString(),
        outdated: false,
      });
      const audits = await db().select().from(auditLog).where(eq(auditLog.event, 'duel.defence'));
      expect(audits.filter((a) => a.characterId === p.hero.id)).toHaveLength(2);
    });

    it('counts a forged or invalid item as nothing (5.1 rules)', async () => {
      const p = await player(22, 'hunter');
      const [first] = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, p.hero.id))
        .orderBy(asc(itemInstances.id))
        .limit(1);
      await db()
        .update(itemInstances)
        .set({ itemLevel: 99 })
        .where(eq(itemInstances.id, first!.id));
      const d = (await api.setDefence(p.who, p.hero.id)).json<ArenaStateResponse>().defence!;
      expect(d.rejected).toEqual(['invalid_item']);
      const [row] = await db().select().from(duelDefences).where(eq(duelDefences.id, d.defenceId));
      expect(row!.snapshot.equipment.some((i) => i.itemLevel === 99)).toBe(false);
      // No item, no seed and no internal id in the answer.
      const body = JSON.stringify(d);
      expect(body).not.toContain(p.hero.id);
      expect(body).not.toContain('"seed"');
    });

    it('is only for your own heroes', async () => {
      const a = await player(12);
      const b = await player(12);
      expect((await api.setDefence(a.who, b.hero.id)).statusCode).toBe(404);
      expect((await api.state(a.who, b.hero.id)).statusCode).toBe(404);
    });
  });

  describe('the rated opponent list', () => {
    it('offers defences in your bracket, never your own, blocked or sanctioned accounts', async () => {
      const me = await player(15);
      const mine2 = await insertCharacter(db(), me.who.id, { classId: 'mage', level: 13 });
      await equipKit(db(), mine2.id, 'mage', 12);
      await defend({ who: me.who, hero: mine2 });
      const good = await player(18, 'warlock');
      const goodId = await defend(good);
      const other = await player(23);
      await defend(other); // 20–29: another bracket
      const low = await player(8);
      await defend(low); // 1–9: no rated duels
      const blockedByMe = await player(12);
      await defend(blockedByMe);
      await block(db(), me.who.id, blockedByMe.who.id);
      const blocksMe = await player(12);
      await defend(blocksMe);
      await block(db(), blocksMe.who.id, me.who.id);
      const muted = await player(11);
      await defend(muted);
      await sanction(db(), muted.who.id, 'mute', new Date(START + 86_400_000));

      // Capacity set up explicitly: other tests' 10–19 defences leave the bracket, so the list
      // (5 at most) holds exactly the eligible one, whatever the test order.
      const here = [me, good, other, low, blockedByMe, blocksMe, muted].map((p) => p.who.id);
      await db()
        .update(duelDefences)
        .set({ bracketId: 'elsewhere' })
        .where(and(eq(duelDefences.bracketId, '10-19'), notInArray(duelDefences.accountId, here)));
      const res = await api.draw(me.who, me.hero.id);
      expect(res.statusCode, res.body).toBe(200);
      const ids = res.json<ArenaStateResponse>().rated.offer!.opponents.map((o) => o.defenceId);
      expect(ids).toEqual([goodId]);
      const [rows] = [await db().select().from(duelDefences).where(inArray(duelDefences.id, ids))];
      const owners = new Set(rows.map((r) => r.accountId));
      for (const p of [me, blockedByMe, blocksMe, muted, other, low])
        expect(owners.has(p.who.id)).toBe(false);
      expect(rows.every((r) => r.bracketId === '10-19' && r.level >= 10)).toBe(true);
      expect(owners.size).toBe(ids.length); // one per account
      expect(ids.length).toBeLessThanOrEqual(DUEL_OFFER_SIZE);
      const view = res
        .json<ArenaStateResponse>()
        .rated.offer!.opponents.find((o) => o.defenceId === goodId)!;
      expect(view).toMatchObject({
        player: { handle: good.who.handle, displayName: good.who.displayName, profile: true },
        hero: { name: good.hero.name, classId: 'warlock', level: 18 },
        setOn: '2026-11-09',
      });
    });

    it('is refreshed at most every 5 minutes while it has opponents; fought ones drop out', async () => {
      const me = await player(16);
      const foe = await player(17);
      const foeId = await defend(foe);
      await setOffer(db(), me.who.id, me.hero.id, '10-19', [foeId], now());
      const early = await api.draw(me.who, me.hero.id);
      expect(early.statusCode).toBe(409);
      expect(code(early)).toBe('offer_fresh');
      expect(early.headers['retry-after']).toBe('300');
      // Fight the only opponent: the list is empty and a fresh one can be drawn at once.
      expect((await api.duel(me.who, me.hero.id, foeId, 'rated')).statusCode).toBe(201);
      const after = (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>();
      expect(after.rated.offer!.opponents).toEqual([]);
      expect((await api.draw(me.who, me.hero.id)).statusCode).toBe(200);
      nowMs += DUEL_OFFER_REFRESH_MS - 1;
      expect((await api.draw(me.who, me.hero.id)).statusCode).toBe(409);
      nowMs += 1;
      expect((await api.draw(me.who, me.hero.id)).statusCode).toBe(200);
    });

    it('takes only an offered id, never one the client chose', async () => {
      const me = await player(19);
      const foe = await player(19);
      const foeId = await defend(foe);
      const res = await api.duel(me.who, me.hero.id, foeId, 'rated');
      expect(res.statusCode).toBe(404);
      expect(code(res)).toBe('not_offered');
      // An offer for another hero of the account does not count either.
      const second = await insertCharacter(db(), me.who.id, { level: 19 });
      await setOffer(db(), me.who.id, second.id, '10-19', [foeId], now());
      expect(code(await api.duel(me.who, me.hero.id, foeId, 'rated'))).toBe('not_offered');
      expect(code(await api.duel(me.who, me.hero.id, randomUUID(), 'rated'))).toBe('not_found');
      expect(
        await db().select().from(duels).where(eq(duels.challengerAccountId, me.who.id)),
      ).toEqual([]);
    });
  });

  describe('the permission matrix (relation × kind, through the API)', () => {
    // Hand-written (docs/PVP.md): the answer for each relation and kind.
    const table: Record<
      Relation | 'guildmate',
      { rated: number; friendly: number; code?: string }
    > = {
      self: { rated: 422, friendly: 422, code: 'cannot_target_self' },
      stranger: { rated: 201, friendly: 403 },
      'requested-by-me': { rated: 201, friendly: 403 },
      'requested-by-them': { rated: 201, friendly: 403 },
      friend: { rated: 201, friendly: 201 },
      guildmate: { rated: 201, friendly: 201 },
      'blocked-by-me': { rated: 404, friendly: 404, code: 'not_found' },
      'blocked-by-them': { rated: 404, friendly: 404, code: 'not_found' },
    };

    it('answers every relation × kind as documented', async () => {
      const me = await player(14);
      const cases: [keyof typeof table, string][] = [];
      for (const relation of Object.keys(table) as (keyof typeof table)[]) {
        if (relation === 'self') {
          const own = await insertCharacter(db(), me.who.id, { level: 14 });
          cases.push([relation, await defend({ who: me.who, hero: own })]);
          continue;
        }
        const them = await player(13);
        const id = await defend(them);
        if (relation === 'requested-by-me') await befriend(db(), me.who.id, them.who.id, 'pending');
        if (relation === 'requested-by-them')
          await befriend(db(), them.who.id, me.who.id, 'pending');
        if (relation === 'friend') await befriend(db(), me.who.id, them.who.id, 'friends');
        if (relation === 'guildmate')
          await insertGuild(db(), me.who.id, { members: [{ accountId: them.who.id }] });
        if (relation === 'blocked-by-me') await block(db(), me.who.id, them.who.id);
        if (relation === 'blocked-by-them') await block(db(), them.who.id, me.who.id);
        cases.push([relation, id]);
      }
      for (const [relation, defenceId] of cases) {
        for (const kind of ['rated', 'friendly'] as const) {
          // Set up explicitly: the defence is on the hero's list (the matrix, not the draw).
          await setOffer(db(), me.who.id, me.hero.id, '10-19', [defenceId], now());
          const res = await api.duel(me.who, me.hero.id, defenceId, kind);
          expect(res.statusCode, `${relation} × ${kind}: ${res.body}`).toBe(table[relation][kind]);
          if (table[relation].code) expect(code(res)).toBe(table[relation].code);
          if (res.statusCode === 403) expect(code(res)).toBe('not_friend_or_guildmate');
        }
      }
    });

    it('rated duels need level 10; friendly challenges need no level and may cross brackets', async () => {
      const young = await player(4, 'hunter');
      const veteran = await player(31, 'warlock');
      const vetId = await defend(veteran);
      await befriend(db(), young.who.id, veteran.who.id, 'friends');
      const state = (await api.state(young.who, young.hero.id)).json<ArenaStateResponse>();
      expect(state.hero).toMatchObject({ ratedOpen: false, bracket: { id: '1-9' } });
      expect(code(await api.draw(young.who, young.hero.id))).toBe('level_too_low');
      await setOffer(db(), young.who.id, young.hero.id, '1-9', [vetId], now());
      const rated = await api.duel(young.who, young.hero.id, vetId, 'rated');
      expect(rated.statusCode).toBe(403);
      expect(code(rated)).toBe('level_too_low');

      const friendly = await api.duel(young.who, young.hero.id, vetId, 'friendly');
      expect(friendly.statusCode, friendly.body).toBe(201);
      const duel = friendly.json<{ duel: DuelView }>().duel;
      expect(duel.bracketId).toBe(friendlyBracket(4, 31).id);
      expect(duel.bracketId).toBe('1-9');
      const { row, replay } = await predicted(duel.id);
      expect(row.outcome).toBe(replay.outcome);
      expect(row.events).toEqual(replay.events);
      expect(duel.events).toEqual(replay.events);
    });

    it('a muted challenger may duel; a suspended one may not; a sanctioned defender is gone', async () => {
      const muted = await player(15);
      const foe = await player(15);
      const foeId = await defend(foe);
      await befriend(db(), muted.who.id, foe.who.id, 'friends');
      await sanction(db(), muted.who.id, 'mute', new Date(START + 86_400_000));
      expect((await api.duel(muted.who, muted.hero.id, foeId, 'friendly')).statusCode).toBe(201);

      const suspended = await player(15);
      await befriend(db(), suspended.who.id, foe.who.id, 'friends');
      await sanction(db(), suspended.who.id, 'suspend', new Date(START + 86_400_000));
      const res = await api.duel(suspended.who, suspended.hero.id, foeId, 'friendly');
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('account_suspended');

      // The defender is sanctioned: off the friendly list, and a duel is a 404.
      const friend = await player(12);
      await befriend(db(), friend.who.id, foe.who.id, 'friends');
      expect(
        (await api.friendly(friend.who)).json<{ opponents: FriendlyOpponentView[] }>().opponents,
      ).toEqual([
        expect.objectContaining({ player: expect.objectContaining({ handle: foe.who.handle }) }),
      ]);
      await sanction(db(), foe.who.id, 'mute', new Date(START + 86_400_000));
      expect(
        (await api.friendly(friend.who)).json<{ opponents: FriendlyOpponentView[] }>().opponents,
      ).toEqual([]);
      const gone = await api.duel(friend.who, friend.hero.id, foeId, 'friendly');
      expect(gone.statusCode).toBe(404);
      await setOffer(db(), friend.who.id, friend.hero.id, '10-19', [foeId], now());
      expect(code(await api.duel(friend.who, friend.hero.id, foeId, 'rated'))).toBe('not_found');
      // ...and off an offered list at read time.
      expect(
        (await api.state(friend.who, friend.hero.id)).json<ArenaStateResponse>().rated.offer!
          .opponents,
      ).toEqual([]);
    });

    it('a block after the offer takes the opponent off the list and refuses the duel', async () => {
      const me = await player(17);
      const foe = await player(17);
      const foeId = await defend(foe);
      await setOffer(db(), me.who.id, me.hero.id, '10-19', [foeId], now());
      expect(
        (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>().rated.offer!.opponents,
      ).toHaveLength(1);
      await block(db(), foe.who.id, me.who.id);
      expect(
        (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>().rated.offer!.opponents,
      ).toEqual([]);
      expect(code(await api.duel(me.who, me.hero.id, foeId, 'rated'))).toBe('not_found');
    });
  });

  describe('idempotency', () => {
    it('the same key gives the same stored duel: no re-roll by retry or replay', async () => {
      const me = await player(21);
      const foe = await player(24);
      const foeId = await defend(foe);
      await befriend(db(), me.who.id, foe.who.id, 'friends');
      const key = randomUUID();
      const first = await api.duel(me.who, me.hero.id, foeId, 'friendly', key);
      expect(first.statusCode, first.body).toBe(201);
      const again = await api.duel(me.who, me.hero.id, foeId, 'friendly', key);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.json()).toEqual(first.json());
      const rows = await db().select().from(duels).where(eq(duels.challengerAccountId, me.who.id));
      expect(rows).toHaveLength(1);
      // The same key for another duel is refused; a missing key is refused.
      expect(code(await api.duel(me.who, me.hero.id, foeId, 'rated', key))).toBe(
        'idempotency_conflict',
      );
      const bare = await api.inject(me.who, 'POST', '/api/arena/duels', {
        characterId: me.hero.id,
        defenceId: foeId,
        kind: 'friendly',
      });
      expect(code(bare)).toBe('idempotency_key_required');
      // Never a client-chosen outcome or seed.
      const extra = await api.inject(
        me.who,
        'POST',
        '/api/arena/duels',
        { characterId: me.hero.id, defenceId: foeId, kind: 'friendly', seed: 'mine' },
        { 'idempotency-key': randomUUID() },
      );
      expect(extra.statusCode).toBe(400);
    });
  });

  describe('the daily limit', () => {
    it('allows 10 rated duels per UTC day, and 10 more after midnight', async () => {
      nowMs = Date.parse('2026-11-10T23:58:00Z');
      const me = await player(25);
      const foes: string[] = [];
      for (let i = 0; i < RATED_DUELS_PER_DAY + 2; i++) foes.push(await defend(await player(26)));
      const friend = await player(22);
      const friendId = await defend(friend);
      await befriend(db(), me.who.id, friend.who.id, 'friends');

      for (let i = 0; i < RATED_DUELS_PER_DAY; i++) {
        await setOffer(db(), me.who.id, me.hero.id, '20-29', [foes[i]!], now());
        const res = await api.duel(me.who, me.hero.id, foes[i]!, 'rated');
        expect(res.statusCode, res.body).toBe(201);
        nowMs += 5_000;
      }
      expect((await api.state(me.who, me.hero.id)).json<ArenaStateResponse>().rated).toMatchObject({
        used: 10,
        left: 0,
      });
      await setOffer(db(), me.who.id, me.hero.id, '20-29', [foes[10]!], now());
      const over = await api.duel(me.who, me.hero.id, foes[10]!, 'rated');
      expect(over.statusCode).toBe(409);
      expect(code(over)).toBe('no_duels_left');
      // Friendly challenges are not counted.
      expect((await api.duel(me.who, me.hero.id, friendId, 'friendly')).statusCode).toBe(201);

      // One millisecond before midnight: still the old day.
      nowMs = Date.parse('2026-11-10T23:59:59.999Z');
      expect(code(await api.duel(me.who, me.hero.id, foes[10]!, 'rated'))).toBe('no_duels_left');
      const state = (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>();
      expect(state.day).toEqual({ key: '2026-11-10', resetsAt: '2026-11-11T00:00:00.000Z' });
      nowMs = Date.parse('2026-11-11T00:00:00.000Z');
      expect((await api.duel(me.who, me.hero.id, foes[10]!, 'rated')).statusCode).toBe(201);
      const rows = await db().select().from(duels).where(eq(duels.challengerAccountId, me.who.id));
      const rated = rows.filter((r) => r.kind === 'rated');
      expect(rated.filter((r) => r.day === '2026-11-10')).toHaveLength(10);
      expect(rated.filter((r) => r.day === '2026-11-11')).toHaveLength(1);
    });
  });

  describe('snapshots', () => {
    it('a defender changing gear after setting the defence changes nothing: the snapshot counts', async () => {
      const me = await player(27, 'mage');
      const foe = await player(28, 'warrior');
      const foeId = await defend(foe);
      const [stored] = await db().select().from(duelDefences).where(eq(duelDefences.id, foeId));
      // The defender re-equips (naked now) and levels up; the defence is not refreshed.
      await db().delete(itemInstances).where(eq(itemInstances.characterId, foe.hero.id));
      await db().update(characters).set({ level: 29 }).where(eq(characters.id, foe.hero.id));
      await setOffer(db(), me.who.id, me.hero.id, '20-29', [foeId], now());
      const res = await api.duel(me.who, me.hero.id, foeId, 'rated');
      expect(res.statusCode, res.body).toBe(201);
      const { row, replay } = await predicted(res.json<{ duel: DuelView }>().duel.id);
      expect(row.defenderSnapshot).toEqual(stored!.snapshot);
      expect(row.defenderSnapshot.equipment.length).toBeGreaterThan(0);
      expect(row.defenderSnapshot.level).toBe(28);
      expect(row.defenceSetAt).toEqual(stored!.setAt);
      expect(row.rulesVersion).toBe(PVP_RULES_VERSION);
      expect(row.seed).toMatch(/^[0-9a-f]{32}$/);
      expect({ outcome: row.outcome, events: row.events, sides: row.sides }).toEqual({
        outcome: replay.outcome,
        events: replay.events,
        sides: replay.sides,
      });
    });

    it('two challengers against one defender both fight the same stored snapshot', async () => {
      const foe = await player(13, 'hunter');
      const foeId = await defend(foe);
      const a = await player(14, 'mage');
      const b = await player(15, 'warlock');
      await setOffer(db(), a.who.id, a.hero.id, '10-19', [foeId], now());
      await setOffer(db(), b.who.id, b.hero.id, '10-19', [foeId], now());
      const [ra, rb] = await Promise.all([
        api.duel(a.who, a.hero.id, foeId, 'rated'),
        api.duel(b.who, b.hero.id, foeId, 'rated'),
      ]);
      expect([ra.statusCode, rb.statusCode]).toEqual([201, 201]);
      const rows = await db().select().from(duels).where(eq(duels.defenceId, foeId));
      expect(rows).toHaveLength(2);
      expect(rows[0]!.defenderSnapshot).toEqual(rows[1]!.defenderSnapshot);
      for (const r of rows) {
        const { replay } = await predicted(r.id);
        expect(r.outcome).toBe(replay.outcome);
      }
    });
  });

  describe('results, history and privacy', () => {
    it('shows the result to both players, never the seed, and nobody else', async () => {
      const me = await player(12, 'warrior', 'Arena Challenger');
      const foe = await player(12, 'mage', 'Arena Defender');
      const foeId = await defend(foe);
      await setOffer(db(), me.who.id, me.hero.id, '10-19', [foeId], now());
      const res = await api.duel(me.who, me.hero.id, foeId, 'rated');
      const duel = res.json<{ duel: DuelView }>().duel;
      const { row } = await predicted(duel.id);
      expect(res.body).not.toContain(row.seed);
      expect(duel).toMatchObject({
        kind: 'rated',
        you: 'challenger',
        bracketId: '10-19',
        rulesVersion: PVP_RULES_VERSION,
        challenger: { player: null, hero: { name: me.hero.name, level: 12 } },
        defender: {
          player: { handle: foe.who.handle, displayName: 'Arena Defender' },
          hero: { name: foe.hero.name, classId: 'mage' },
          pveStats: null,
        },
      });
      expect(duel.challenger.pveStats!.health).toBeGreaterThan(0);
      expect(duel.result).toBe(
        row.outcome === 'draw' ? 'draw' : row.outcome === 'challenger' ? 'won' : 'lost',
      );

      const theirs = await api.view(foe.who, duel.id);
      expect(theirs.statusCode).toBe(200);
      expect(theirs.json<{ duel: DuelView }>().duel).toMatchObject({
        you: 'defender',
        challenger: { player: { handle: me.who.handle } },
        events: duel.events,
      });
      expect(theirs.body).not.toContain(row.seed);
      const stranger = await player(12);
      expect((await api.view(stranger.who, duel.id)).statusCode).toBe(404);

      // History, attacking and defending.
      const mine = (await api.history(me.who)).json<{ duels: DuelSummaryView[] }>().duels;
      expect(mine[0]).toMatchObject({ id: duel.id, you: 'challenger', kind: 'rated' });
      const def = (await api.history(foe.who)).json<{ duels: DuelSummaryView[] }>().duels;
      expect(def[0]).toMatchObject({
        id: duel.id,
        you: 'defender',
        opponent: { player: { handle: me.who.handle }, blocked: false },
      });

      // A block later hides the name in both views.
      await block(db(), foe.who.id, me.who.id);
      const hidden = (await api.history(foe.who)).json<{ duels: DuelSummaryView[] }>().duels[0]!;
      expect(hidden.opponent).toMatchObject({ player: null, blocked: true, hero: { name: null } });
      expect(
        (await api.view(me.who, duel.id)).json<{ duel: DuelView }>().duel.defender,
      ).toMatchObject({ player: null, blocked: true });
    });

    it('hides a hero name where the profile may not be opened', async () => {
      const me = await player(16);
      const foe = await player(16);
      await db().execute(
        sql`update accounts set profile_visibility = 'hidden' where id = ${foe.who.id}`,
      );
      const foeId = await defend(foe);
      await setOffer(db(), me.who.id, me.hero.id, '10-19', [foeId], now());
      const opp = (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>().rated.offer!
        .opponents[0]!;
      expect(opp).toMatchObject({
        player: { handle: foe.who.handle, profile: false },
        hero: { name: null, level: 16 },
      });
    });

    it('pages the history', async () => {
      const me = await player(18);
      const foe = await player(18);
      const foeId = await defend(foe);
      await befriend(db(), me.who.id, foe.who.id, 'friends');
      for (let i = 0; i < 5; i++) {
        expect((await api.duel(me.who, me.hero.id, foeId, 'friendly')).statusCode).toBe(201);
        nowMs += 1000;
      }
      const p1 = (await api.history(me.who, '?limit=3')).json<{
        duels: DuelSummaryView[];
        nextCursor: string | null;
      }>();
      expect(p1.duels).toHaveLength(3);
      const p2 = (await api.history(me.who, `?limit=3&cursor=${p1.nextCursor}`)).json<{
        duels: DuelSummaryView[];
        nextCursor: string | null;
      }>();
      expect(p2.duels).toHaveLength(2);
      expect(p2.nextCursor).toBeNull();
      expect(new Set([...p1.duels, ...p2.duels].map((d) => d.id)).size).toBe(5);
      expect((await api.history(me.who, '?cursor=bogus')).statusCode).toBe(400);
    });

    it('the friendly list shows friends and guildmates with their defences', async () => {
      const me = await player(9);
      const friend = await player(30, 'mage', 'Friendly Mage');
      await befriend(db(), me.who.id, friend.who.id, 'friends');
      const mate = await player(5, 'hunter', 'Guild Hunter');
      await insertGuild(db(), me.who.id, { members: [{ accountId: mate.who.id }] });
      const stranger = await player(9);
      await defend(stranger);
      const friendDef = await defend(friend);
      const list = (await api.friendly(me.who)).json<{ opponents: FriendlyOpponentView[] }>()
        .opponents;
      expect(list).toEqual([
        expect.objectContaining({
          relation: 'friend',
          player: expect.objectContaining({ displayName: 'Friendly Mage' }),
          defences: [expect.objectContaining({ defenceId: friendDef, bracketId: '30-plus' })],
        }),
        expect.objectContaining({ relation: 'guildmate', defences: [] }),
      ]);
    });

    it('a duel result can be reported through the report flow', async () => {
      const me = await player(20);
      const foe = await player(20);
      const foeId = await defend(foe);
      await befriend(db(), me.who.id, foe.who.id, 'friends');
      const duel = (await api.duel(me.who, me.hero.id, foeId, 'friendly')).json<{
        duel: DuelView;
      }>().duel;
      const report = await api.inject(me.who, 'POST', '/api/reports', {
        target: { kind: 'player', handle: duel.defender.player!.handle },
        reason: 'cheating',
      });
      expect(report.statusCode, report.body).toBe(201);
    });
  });

  describe('invariance', () => {
    it('a duel changes nothing a player owns: gold, items, XP, materials, scores', async () => {
      const a = await player(23, 'warlock');
      const b = await player(24, 'hunter');
      await db()
        .update(characters)
        .set({ gold: 1234, experience: 456 })
        .where(eq(characters.id, a.hero.id));
      await db()
        .update(characters)
        .set({ gold: 789, experience: 12 })
        .where(eq(characters.id, b.hero.id));
      const ids = [a.hero.id, b.hero.id];
      const snapshot = async () => {
        const heroes = await db()
          .select()
          .from(characters)
          .where(inArray(characters.id, ids))
          .orderBy(asc(characters.id));
        const items = await db()
          .select()
          .from(itemInstances)
          .where(inArray(itemInstances.characterId, ids))
          .orderBy(asc(itemInstances.id));
        const mats = await db()
          .select()
          .from(characterMaterials)
          .where(inArray(characterMaterials.characterId, ids));
        const boards = await db()
          .select()
          .from(leaderboardEntries)
          .where(inArray(leaderboardEntries.characterId, ids))
          .orderBy(asc(leaderboardEntries.characterId), asc(leaderboardEntries.metric));
        const scores = await Promise.all([
          app.inject({
            method: 'GET',
            url: `/api/characters/${a.hero.id}/scores`,
            cookies: { wf_session: a.who.token },
          }),
          app.inject({
            method: 'GET',
            url: `/api/characters/${b.hero.id}/scores`,
            cookies: { wf_session: b.who.token },
          }),
        ]);
        return createHash('sha256')
          .update(
            JSON.stringify({
              heroes,
              items,
              mats,
              boards,
              scores: scores.map((s) => s.json()),
            }),
          )
          .digest('hex');
      };
      const aDef = await defend(a);
      const bDef = await defend(b);
      await befriend(db(), a.who.id, b.who.id, 'friends');
      const before = await snapshot();
      const outcomes = new Set<string>();
      for (let i = 0; i < 6; i++) {
        await setOffer(db(), a.who.id, a.hero.id, '20-29', [bDef], now());
        const r1 = await api.duel(a.who, a.hero.id, bDef, i % 2 === 0 ? 'rated' : 'friendly');
        const r2 = await api.duel(b.who, b.hero.id, aDef, 'friendly');
        expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
        outcomes.add(r1.json<{ duel: DuelView }>().duel.result);
        outcomes.add(r2.json<{ duel: DuelView }>().duel.result);
        nowMs += MIN;
      }
      expect(outcomes.size).toBeGreaterThan(0);
      expect(await snapshot()).toBe(before);
      // The audit log and the telemetry rollups still reconcile (duels included).
      const checks = await reconcileWithAudit(db());
      expect(checks.filter((c) => !c.ok)).toEqual([]);
      expect(checks.find((c) => c.check === 'duels: friendly')!.audit).toBeGreaterThanOrEqual(9);
      expect(checks.find((c) => c.check === 'duels: rated')!.audit).toBeGreaterThanOrEqual(3);
    });
  });
});
