/**
 * Ticket 8.4b: the Guild Roll's "reached first" comes from the facts' own times, not from when a
 * row was refreshed. Two guilds tied on every part, refreshed and read in either order; the order
 * stays across a recompute from nothing and into the archive; a refresh that raises nothing keeps
 * the time; the window rule at a season boundary. One injected game clock; dates derive from the
 * wall clock (CLAUDE.md "Dates").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  guildMembers,
  guildSeasonEntries,
  guildSeasonStandings,
  type Guild,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import {
  DAY,
  dayFromNow,
  insertGift,
  insertPve,
  insertSeason,
  insertStage,
} from '../test/guild-seasons.js';
import { runSeasonJobs } from '../seasons/model.js';
import { checkGuildSeasons, refreshGuildSeason } from './model.js';

const day = (d: Date) => d.toISOString().slice(0, 10);

describe('Guild Roll: reached first, from the facts', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  const START = dayFromNow(1);
  const END = new Date(START.getTime() + 56 * DAY);
  const at = (days: number) => new Date(START.getTime() + days * DAY);
  let nowMs = at(1).getTime();
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    call = caller(app);
    await insertSeason(db(), 1, START, END);
    await insertSeason(db(), 2, END, new Date(END.getTime() + 56 * DAY));
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  /** Three counted members, each with a full PvE share reached before the season. */
  async function guildOf() {
    const players: TestAccount[] = [];
    for (let i = 0; i < 3; i++) players.push(await insertAccount(db()));
    const guild = await insertGuild(db(), players[0]!.id, {
      members: players.slice(1).map((p) => ({ accountId: p.id })),
      now: new Date(START.getTime() - 30 * DAY),
    });
    for (const p of players) {
      await insertPve(db(), p.id, 25, 6, new Date(START.getTime() - 10 * DAY));
    }
    return { guild, players };
  }

  const rowOf = async (g: Guild, season = 1) =>
    (
      await db()
        .select()
        .from(guildSeasonEntries)
        .where(and(eq(guildSeasonEntries.season, season), eq(guildSeasonEntries.guildId, g.id)))
    )[0]!;
  const boardTags = async (who: TestAccount) => {
    const res = await call(who, 'GET', '/api/leaderboards/guilds');
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().entries as { guild: { tag: string } }[]).map((e) => e.guild.tag);
  };

  // `late` is created first, so its guild id sorts first: only "reached first" puts `early` ahead.
  let late: Awaited<ReturnType<typeof guildOf>>;
  let early: Awaited<ReturnType<typeof guildOf>>;

  it('ranks the guild that reached a tied score first, whatever the refresh and read order', async () => {
    late = await guildOf();
    early = await guildOf();
    expect(late.guild.id < early.guild.id).toBe(true);
    await insertStage(db(), late.guild.id, late.players[0]!.id, 1, at(1));
    await insertStage(db(), early.guild.id, early.players[0]!.id, 1, at(1));
    await insertStage(db(), late.guild.id, late.players[1]!.id, 2, at(3));
    await insertStage(db(), early.guild.id, early.players[1]!.id, 2, at(2));

    // The later guild is refreshed first, the earlier one a day after (8.4 put `late` ahead).
    nowMs = at(5).getTime();
    await refreshGuildSeason(db(), now(), new Date(), [late.guild.id]);
    nowMs = at(6).getTime();
    await refreshGuildSeason(db(), now(), new Date(), [early.guild.id]);
    const [l, e] = [await rowOf(late.guild), await rowOf(early.guild)];
    expect(l.sortKey.map(Number)).toEqual(e.sortKey.map(Number));
    expect(l.achievedAt).toEqual(at(3));
    expect(e.achievedAt).toEqual(at(2));

    // A member of the later guild reads the roll (which refreshes their guild) a day on.
    nowMs = at(7).getTime();
    expect((await boardTags(late.players[2]!)).slice(0, 2)).toEqual([
      early.guild.tag,
      late.guild.tag,
    ]);
    expect((await rowOf(late.guild)).achievedAt).toEqual(at(3));
    // And the earlier guild's member, in the other order.
    nowMs = at(8).getTime();
    await refreshGuildSeason(db(), now(), new Date(), [early.guild.id]);
    await refreshGuildSeason(db(), now(), new Date(), [late.guild.id]);
    expect((await boardTags(early.players[2]!)).slice(0, 2)).toEqual([
      early.guild.tag,
      late.guild.tag,
    ]);
  });

  it('keeps the order across a recompute from nothing', async () => {
    const before = [await rowOf(late.guild), await rowOf(early.guild)];
    await db().delete(guildSeasonEntries).where(eq(guildSeasonEntries.season, 1));
    nowMs = at(9).getTime();
    await refreshGuildSeason(db(), now(), new Date());
    const after = [await rowOf(late.guild), await rowOf(early.guild)];
    expect(after.map((r) => r.achievedAt)).toEqual(before.map((r) => r.achievedAt));
    expect(after.map((r) => r.inputsHash)).toEqual(before.map((r) => r.inputsHash));
    expect((await boardTags(late.players[0]!)).slice(0, 2)).toEqual([
      early.guild.tag,
      late.guild.tag,
    ]);
    expect((await checkGuildSeasons(db())).wrong).toEqual([]);
  });

  it('a refresh that raises nothing keeps "reached at"; a refresh-time row is corrected', async () => {
    const giver = await guildOf();
    const [a] = giver.players;
    // A whole need of gold on day 4: the member's town-works part is full (100).
    await insertGift(db(), a!.id, day(at(4)), 4_000, {
      projectId: 'restoreWarehouse',
      stageId: 'clearRubble',
      resource: 'gold',
    });
    nowMs = at(10).getTime();
    await refreshGuildSeason(db(), now(), new Date(), [giver.guild.id]);
    const first = await rowOf(giver.guild);
    expect(first.achievedAt).toEqual(at(4));

    // Nothing new, a later clock: nothing is rewritten.
    nowMs = at(11).getTime();
    expect((await refreshGuildSeason(db(), now(), new Date(), [giver.guild.id])).updated).toBe(0);

    // More gold past the member's cap, and a joiner who counts from today with nothing yet: the
    // input changes (the row is rewritten), the score does not, and neither does the time.
    await insertGift(db(), a!.id, day(at(9)), 3_000, {
      projectId: 'restoreWarehouse',
      stageId: 'clearRubble',
      resource: 'gold',
    });
    const joiner = await insertAccount(db());
    await db()
      .insert(guildMembers)
      .values({ accountId: joiner.id, guildId: giver.guild.id, role: 'member', joinedAt: at(4) });
    nowMs = at(12).getTime();
    expect((await refreshGuildSeason(db(), now(), new Date(), [giver.guild.id])).updated).toBe(1);
    const second = await rowOf(giver.guild);
    expect(second.inputsHash).not.toBe(first.inputsHash);
    expect(second.members).toBe(first.members + 1);
    expect(second.sortKey.map(Number)).toEqual(first.sortKey.map(Number));
    expect(second.achievedAt).toEqual(at(4));

    // A row written before 8.4b carried its refresh's clock: the next refresh corrects it.
    await db()
      .update(guildSeasonEntries)
      .set({ achievedAt: now() })
      .where(eq(guildSeasonEntries.guildId, giver.guild.id));
    nowMs = at(13).getTime();
    expect((await refreshGuildSeason(db(), now(), new Date(), [giver.guild.id])).updated).toBe(1);
    expect((await rowOf(giver.guild)).achievedAt).toEqual(at(4));
  });

  let edge: Awaited<ReturnType<typeof guildOf>>;

  it('the archive uses the same order and times', async () => {
    edge = await guildOf();
    // The last millisecond of season 1, and the first of season 2.
    await insertStage(db(), edge.guild.id, edge.players[0]!.id, 1, new Date(END.getTime() - 1));
    await insertStage(db(), edge.guild.id, edge.players[1]!.id, 2, END);
    nowMs = END.getTime() - 1;
    await refreshGuildSeason(db(), now(), new Date());
    const live = await db()
      .select()
      .from(guildSeasonEntries)
      .where(eq(guildSeasonEntries.season, 1));
    nowMs = END.getTime() + 10 * 60_000;
    await runSeasonJobs(db(), now(), new Date());
    const standings = (
      await db().select().from(guildSeasonStandings).where(eq(guildSeasonStandings.season, 1))
    ).sort((x, y) => x.rank - y.rank);
    const ids = standings.map((s) => s.guildId);
    expect(ids.indexOf(early.guild.id)).toBeLessThan(ids.indexOf(late.guild.id));
    for (const s of standings) {
      expect(s.achievedAt).toEqual(live.find((r) => r.guildId === s.guildId)!.achievedAt);
    }
    // The stage at the season's last millisecond counts in season 1, at that moment.
    expect(standings.find((s) => s.guildId === edge.guild.id)!.achievedAt).toEqual(
      new Date(END.getTime() - 1),
    );
    expect((await checkGuildSeasons(db())).wrong).toEqual([]);
  });

  it('the window rule at the boundary: season 2 starts its times at its own start', async () => {
    nowMs = END.getTime() + DAY;
    await refreshGuildSeason(db(), now(), new Date());
    // Facts from before the season (the PvE shares) count from the season's start.
    expect((await rowOf(early.guild, 2)).achievedAt).toEqual(END);
    expect((await rowOf(late.guild, 2)).achievedAt).toEqual(END);
    // The stage broken at the boundary belongs to season 2 alone.
    const e2 = await rowOf(edge.guild, 2);
    expect(e2.input.stages).toEqual([2]);
    expect(e2.achievedAt).toEqual(END);
    expect((await rowOf(early.guild, 2)).input.stages).toEqual([]);
  });
});
