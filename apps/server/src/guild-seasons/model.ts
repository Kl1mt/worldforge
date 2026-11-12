import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  GUILD_SEASON_FORMULA_VERSION,
  GUILD_SEASON_RULES,
  giftDayCounts,
  guildSeasonAwards as computeGuildAwards,
  guildSeasonCosmeticsEarned,
  guildSeasonInputAt,
  guildSeasonReachedAt,
  guildSeasonScore,
  memberCommunityPoints,
  memberHonourEligible,
  pveMilestones,
  type GuildHonourTier,
  type GuildSeasonInput,
  type GuildSeasonScore,
  type GuildSeasonTimedMember,
  type GuildSeasonTimeline,
  type ProjectResource,
} from '@worldforge/game-core';
import {
  guildSeasonAwards,
  guildSeasonEntries,
  guildSeasonRosters,
  guildSeasonStandings,
  guilds,
  seasons,
  type Season,
} from '../db/schema.js';
import { canonicalJson } from '../idempotency/index.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { notifyTx } from '../inbox/notify.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import { grantCosmeticsTx } from '../cosmetics/grant.js';

/**
 * The guild season roll (ticket 8.4, docs/LEADERBOARDS.md "Guild seasons"). Every guild's score is
 * game-core `guildSeasonScore` of an input the server gathers from stored facts (the guild boss
 * stages it reached, its counted members' best PvE Progress rows, their town-works gifts); a client
 * never submits one. The churn rules (`GUILD_SEASON_RULES`) decide who counts.
 *
 * - **Live roll:** `refreshGuildSeason` rewrites each guild's `guild_season_entries` row for the
 *   season under way (the scheduler's season step; a member's board read refreshes their own guild)
 *   under the season's shared lock, like 5.2's refreshes, so the archive waits for it.
 * - **Archive:** `archiveGuildSeasonTx` runs inside 5.3's `archiveSeason` transaction (the season's
 *   exclusive lock): every guild is scored at the season's end, the listed ones ranked into
 *   `guild_season_standings`, and each ranked guild's honour roll written (`guild_season_rosters`).
 * - **Awards:** `awardGuildSeason`, exactly once and resumable: honours by the primary key, member
 *   cosmetics by `cosmetic_unlocks`' key, `guild_awarded_at` and the audit row last.
 */

const lockKey = (key: string) => sql`hashtextextended(${key}, 0)`;
const seasonLock = (n: number) => `season:${n}`;
const DAY_MS = 86_400_000;

export interface GuildFacts {
  guildId: string;
  input: GuildSeasonInput;
  /** The same facts with their times (`input` = `guildSeasonInputAt(timeline)`), for "reached at". */
  timeline: GuildSeasonTimeline;
  /** The counted members' account ids (same order as `input.members`). */
  counted: string[];
  /** Per counted member: joined at, and their town-works points (for the honour roll). */
  detail: Map<string, { joinedAt: Date; communityPoints: number }>;
}

const activeSanction = (alias: string, at: Date) =>
  sql.raw(`exists (select 1 from sanctions s where s.subject_id = ${alias} and s.lifted_at is null
    and s.expires_at > '${at.toISOString()}'::timestamptz)`);

/**
 * Gathers each guild's input for a season at `at` (the refresh's clock, or the season's end for
 * the archive). `sanctionsAt`: the auth clock for the sanction rule.
 */
export async function gatherGuildFacts(
  executor: Executor,
  opts: {
    window: { startsAt: Date; endsAt: Date };
    at: Date;
    sanctionsAt: Date;
    guildIds?: readonly string[];
  },
): Promise<Map<string, GuildFacts>> {
  const { window, at } = opts;
  const only = opts.guildIds
    ? sql`and g.id = any(${`{${opts.guildIds.join(',')}}`}::uuid[])`
    : sql``;
  if (opts.guildIds && opts.guildIds.length === 0) return new Map();
  const guildRows = await queryRows<{ id: string }>(
    executor,
    sql`select g.id from guilds g where g.disbanded_at is null ${only} order by g.id`,
  );
  const out = new Map<string, GuildFacts>();
  for (const g of guildRows) {
    out.set(g.id, {
      guildId: g.id,
      input: { stages: [], members: [] },
      timeline: { stages: [], members: [] },
      counted: [],
      detail: new Map(),
    });
  }
  if (out.size === 0) return out;
  const ids = `{${[...out.keys()].join(',')}}`;
  const cutoff = new Date(at.getTime() - GUILD_SEASON_RULES.countAfterDays * DAY_MS);
  const members = await queryRows<{
    guild_id: string;
    account_id: string;
    joined_at: Date | string;
  }>(
    executor,
    sql`select m.guild_id, m.account_id, m.joined_at from guild_members m
      join accounts a on a.id = m.account_id
      where m.guild_id = any(${ids}::uuid[]) and not a.is_test
        and m.joined_at <= ${cutoff.toISOString()}::timestamptz
        and not ${activeSanction('m.account_id', opts.sanctionsAt)}
      order by m.account_id`,
  );
  const stages = await queryRows<{ guild_id: string; stage: number; reached_at: Date | string }>(
    executor,
    sql`select guild_id, stage, reached_at from guild_boss_stages
      where guild_id = any(${ids}::uuid[])
        and reached_at >= ${window.startsAt.toISOString()}::timestamptz
        and reached_at < ${window.endsAt.toISOString()}::timestamptz
        and reached_at <= ${at.toISOString()}::timestamptz
      order by guild_id, week, stage`,
  );
  for (const s of stages) {
    const f = out.get(s.guild_id);
    if (f) {
      (f.timeline.stages as GuildSeasonTimeline['stages'][number][]).push({
        stage: Number(s.stage),
        at: new Date(s.reached_at).getTime(),
      });
    }
  }
  if (members.length === 0) {
    for (const f of out.values()) f.input = guildSeasonInputAt(f.timeline);
    return out;
  }
  const accountIds = `{${members.map((m) => m.account_id).join(',')}}`;
  const pveRows = await queryRows<{
    account_id: string;
    value: number;
    formula_version: number;
    achieved_at: Date | string;
  }>(
    executor,
    sql`select e.account_id, e.value, e.formula_version, e.achieved_at from leaderboard_entries e
      join characters c on c.id = e.character_id
      where e.metric = 'pveProgress' and c.deleted_at is null
        and e.account_id = any(${accountIds}::uuid[])`,
  );
  // The best share per account; between heroes with the same share, the one that reached it first.
  const bestPve = new Map<string, { value: number; of: number; at: number }>();
  for (const r of pveRows) {
    let of: number;
    try {
      of = pveMilestones(Number(r.formula_version)).length;
    } catch {
      continue;
    }
    const value = Number(r.value);
    const at = new Date(r.achieved_at).getTime();
    const prev = bestPve.get(r.account_id);
    const better = prev ? value * prev.of - prev.value * of : 1;
    if (!prev || better > 0 || (better === 0 && at < prev.at)) {
      bestPve.set(r.account_id, { value, of, at });
    }
  }
  const startDay = window.startsAt.toISOString().slice(0, 10);
  const endDay = window.endsAt.toISOString().slice(0, 10);
  const gifts = await queryRows<{
    account_id: string;
    project_id: string;
    stage_id: string;
    resource: string;
    day: string;
    amount: number;
  }>(
    executor,
    sql`select account_id, project_id, stage_id, resource, day::text as day, amount
      from community_contributions
      where account_id = any(${accountIds}::uuid[])
        and day >= ${startDay}::date and day <= ${endDay}::date
        and day <= ${at.toISOString().slice(0, 10)}::date
      order by account_id, project_id, stage_id, resource, day`,
  );
  const giftsOf = new Map<string, typeof gifts>();
  for (const g of gifts) {
    const list = giftsOf.get(g.account_id) ?? [];
    list.push(g);
    giftsOf.set(g.account_id, list);
  }
  for (const m of members) {
    const facts = out.get(m.guild_id);
    if (!facts) continue;
    const joinedAt = new Date(m.joined_at);
    const timed: GuildSeasonTimedMember = {
      countsFrom: joinedAt.getTime() + GUILD_SEASON_RULES.countAfterDays * DAY_MS,
      pve: bestPve.get(m.account_id) ?? null,
      // Only a day that began inside the season (and before `at`) and after the joining day.
      gifts: (giftsOf.get(m.account_id) ?? [])
        .filter(
          (g) =>
            giftDayCounts(g.day, joinedAt, window) &&
            Date.parse(`${g.day}T00:00:00.000Z`) <= at.getTime(),
        )
        .map((g) => ({
          projectId: g.project_id,
          stageId: g.stage_id,
          resource: g.resource as ProjectResource,
          amount: Number(g.amount),
          at: Date.parse(`${g.day}T00:00:00.000Z`),
        })),
    };
    (facts.timeline.members as GuildSeasonTimedMember[]).push(timed);
    facts.counted.push(m.account_id);
    facts.detail.set(m.account_id, { joinedAt, communityPoints: 0 });
  }
  for (const f of out.values()) {
    f.input = guildSeasonInputAt(f.timeline);
    f.counted.forEach((accountId, i) => {
      f.detail.get(accountId)!.communityPoints = memberCommunityPoints(f.input.members[i]!);
    });
  }
  return out;
}

/** SHA-256 of the canonical JSON of an input at a version (`inputs_hash`). */
export function guildInputsHash(input: GuildSeasonInput, version: number): string {
  return createHash('sha256')
    .update(`guildSeason:v${version}\n${canonicalJson(input)}`)
    .digest('hex');
}

const sameKey = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));

/**
 * "Reached at" (ticket 8.4b): when the guild reached its `sortKey`, from the facts' own times
 * (`guildSeasonReachedAt`, within the window `[startsAt, at]`), never the refresh's clock. While the
 * key stays the same it never moves later (a fact that raised nothing, or a member's PvE tie-breaker
 * moving, keeps it); it can only move earlier, which also corrects rows written before 8.4b, whose
 * time was a refresh's.
 */
function reachedAt(
  f: GuildFacts,
  score: GuildSeasonScore,
  window: { startsAt: Date },
  at: Date,
  prev: { sortKey: number[]; achievedAt: Date } | undefined,
): Date {
  const derived = guildSeasonReachedAt(
    f.timeline,
    { startsAt: window.startsAt.getTime(), at: at.getTime() },
    score.formulaVersion,
  );
  if (prev && sameKey(prev.sortKey, score.sortKey) && prev.achievedAt.getTime() <= derived) {
    return prev.achievedAt;
  }
  return new Date(derived);
}

/** Whether a score is listed (the board's minimum counted members and a score above zero). */
export const isListed = (score: Pick<GuildSeasonScore, 'value' | 'members'>) =>
  score.value > 0 && score.members >= GUILD_SEASON_RULES.minMembers;

export interface GuildRefreshReport {
  season: number | null;
  refreshed: number;
  updated: number;
}

/**
 * Rewrites the live roll of the season under way at `now` (every guild, or `guildIds`). Under the
 * season's shared lock, so an archive in progress waits for it and none writes after it.
 */
export async function refreshGuildSeason(
  db: Database,
  now: Date,
  sanctionsAt: Date,
  guildIds?: readonly string[],
): Promise<GuildRefreshReport> {
  return withTransaction(db, async (tx) => {
    const season = await lockOpenSeasonShared(tx, now);
    if (!season) return { season: null, refreshed: 0, updated: 0 };
    const facts = await gatherGuildFacts(tx, {
      window: season,
      at: now,
      sanctionsAt,
      ...(guildIds ? { guildIds } : {}),
    });
    const existing = await tx
      .select()
      .from(guildSeasonEntries)
      .where(
        and(
          eq(guildSeasonEntries.season, season.number),
          ...(guildIds ? [inArray(guildSeasonEntries.guildId, [...guildIds])] : []),
        ),
      );
    const byGuild = new Map(existing.map((e) => [e.guildId, e]));
    let updated = 0;
    for (const f of facts.values()) {
      const version = GUILD_SEASON_FORMULA_VERSION;
      const score = guildSeasonScore(f.input, version);
      const hash = guildInputsHash(f.input, version);
      const prev = byGuild.get(f.guildId);
      const achievedAt = reachedAt(f, score, season, now, prev);
      if (
        prev &&
        prev.inputsHash === hash &&
        prev.formulaVersion === version &&
        prev.achievedAt.getTime() === achievedAt.getTime()
      ) {
        continue;
      }
      // Nothing to show and nothing stored: no row (a guild appears once it has any score).
      if (!prev && score.value === 0) continue;
      await tx
        .insert(guildSeasonEntries)
        .values({
          season: season.number,
          guildId: f.guildId,
          formulaVersion: version,
          value: score.value,
          sortKey: score.sortKey,
          inputsHash: hash,
          input: f.input,
          members: score.members,
          achievedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [guildSeasonEntries.season, guildSeasonEntries.guildId],
          set: {
            formulaVersion: version,
            value: score.value,
            sortKey: score.sortKey,
            inputsHash: hash,
            input: f.input,
            members: score.members,
            achievedAt,
            updatedAt: now,
          },
        });
      updated += 1;
    }
    return { season: season.number, refreshed: facts.size, updated };
  });
}

/** The season under way at `at`, not archived, with its lock taken shared (refreshes). */
async function lockOpenSeasonShared(tx: Transaction, at: Date): Promise<Season | null> {
  const iso = at.toISOString();
  const [candidate] = await tx
    .select()
    .from(seasons)
    .where(
      and(
        sql`${seasons.startsAt} <= ${iso}::timestamptz`,
        sql`${seasons.endsAt} > ${iso}::timestamptz`,
        sql`${seasons.archivedAt} is null`,
      ),
    );
  if (!candidate) return null;
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(${lockKey(seasonLock(candidate.number))})`,
  );
  const [fresh] = await tx.select().from(seasons).where(eq(seasons.number, candidate.number));
  if (!fresh || fresh.archivedAt) return null;
  return fresh;
}

/** Guilds left off the roll at `at`: a leader with an active sanction, or a forced rename. */
export async function guildsLeftOff(executor: Executor, at: Date, guildIds: readonly string[]) {
  if (guildIds.length === 0) return new Set<string>();
  const rows = await queryRows<{ id: string }>(
    executor,
    sql`select g.id from guilds g
      where g.id = any(${`{${guildIds.join(',')}}`}::uuid[]) and (
        g.disbanded_at is not null or g.rename_required
        or exists (select 1 from guild_members l where l.guild_id = g.id and l.role = 'leader'
          and ${activeSanction('l.account_id', at)}))`,
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Inside `archiveSeason`'s transaction (the season's exclusive lock held): scores every guild at
 * the season's end, ranks the listed ones into `guild_season_standings` and writes each ranked
 * guild's honour roll. Returns how many guilds were ranked.
 */
export async function archiveGuildSeasonTx(
  tx: Transaction,
  season: Season,
  sanctionsAt: Date,
): Promise<{ ranked: number; roster: number }> {
  const facts = await gatherGuildFacts(tx, { window: season, at: season.endsAt, sanctionsAt });
  const existing = await tx
    .select()
    .from(guildSeasonEntries)
    .where(eq(guildSeasonEntries.season, season.number));
  const prevOf = new Map(existing.map((e) => [e.guildId, e]));
  const leftOff = await guildsLeftOff(tx, sanctionsAt, [...facts.keys()]);
  const scored = [...facts.values()]
    .map((f) => {
      const score = guildSeasonScore(f.input);
      const achievedAt = reachedAt(f, score, season, season.endsAt, prevOf.get(f.guildId));
      return { f, score, achievedAt };
    })
    .filter((s) => isListed(s.score) && !leftOff.has(s.f.guildId))
    .sort(
      (a, b) =>
        compareKeys(a.score.sortKey, b.score.sortKey) ||
        a.achievedAt.getTime() - b.achievedAt.getTime() ||
        (a.f.guildId < b.f.guildId ? -1 : 1),
    );
  if (scored.length === 0) return { ranked: 0, roster: 0 };
  const info = await tx
    .select({ id: guilds.id, name: guilds.name, tag: guilds.tag, emblem: guilds.emblem })
    .from(guilds)
    .where(
      inArray(
        guilds.id,
        scored.map((s) => s.f.guildId),
      ),
    );
  const infoOf = new Map(info.map((g) => [g.id, g]));
  // Who fought the guild boss for each guild inside the season (the "took part" rule).
  const fought = await queryRows<{ guild_id: string; account_id: string }>(
    tx,
    sql`select distinct guild_id, account_id from guild_boss_attempts
      where account_id is not null
        and guild_id = any(${`{${scored.map((s) => s.f.guildId).join(',')}}`}::uuid[])
        and created_at >= ${season.startsAt.toISOString()}::timestamptz
        and created_at < ${season.endsAt.toISOString()}::timestamptz`,
  );
  const fighters = new Set(fought.map((r) => `${r.guild_id}:${r.account_id}`));
  let roster = 0;
  for (let i = 0; i < scored.length; i++) {
    const { f, score, achievedAt } = scored[i]!;
    const g = infoOf.get(f.guildId)!;
    await tx.insert(guildSeasonStandings).values({
      season: season.number,
      guildId: f.guildId,
      rank: i + 1,
      name: g.name,
      tag: g.tag,
      emblem: g.emblem,
      formulaVersion: score.formulaVersion,
      value: score.value,
      sortKey: score.sortKey,
      inputsHash: guildInputsHash(f.input, score.formulaVersion),
      input: f.input,
      members: score.members,
      achievedAt,
    });
    const roll = f.counted.filter((accountId) => {
      const d = f.detail.get(accountId)!;
      if (!memberHonourEligible(d.joinedAt, season.endsAt)) return false;
      return d.communityPoints > 0 || fighters.has(`${f.guildId}:${accountId}`);
    });
    if (roll.length > 0) {
      await tx
        .insert(guildSeasonRosters)
        .values(roll.map((accountId) => ({ season: season.number, accountId, guildId: f.guildId })))
        .onConflictDoNothing();
      roster += roll.length;
    }
  }
  return { ranked: scored.length, roster };
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = Number(b[i] ?? 0) - Number(a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface GuildAwardOptions {
  /** Member grants per transaction. */
  batch?: number;
  /** Tests only: throw after this many batches (a crash mid-award). */
  failAfterBatches?: number;
}

export type GuildAwardOutcome =
  | { kind: 'awarded'; guilds: number; members: number }
  | { kind: 'already' | 'not_archived' | 'missing' | 'none' };

/**
 * Gives a season's guild honours from its archive: each ranked guild's tier (`guild_season_awards`,
 * exactly once by its key), and the tier's cosmetics to every account on its honour roll (exactly
 * once by `cosmetic_unlocks`' key; source `guildSeason:<n>`). Resumable: a crash leaves
 * `guild_awarded_at` null and the next run finishes the same set. A season archived before 8.4
 * (no guild archive) is marked done with nothing.
 */
export async function awardGuildSeason(
  db: Database,
  number: number,
  now: Date,
  options: GuildAwardOptions = {},
): Promise<GuildAwardOutcome> {
  const [season] = await db.select().from(seasons).where(eq(seasons.number, number));
  if (!season) return { kind: 'missing' };
  if (!season.archivedAt) return { kind: 'not_archived' };
  if (season.guildAwardedAt) return { kind: 'already' };
  if (!season.guildArchivedAt) {
    await db
      .update(seasons)
      .set({ guildAwardedAt: now })
      .where(and(eq(seasons.number, number), sql`${seasons.guildAwardedAt} is null`));
    return { kind: 'none' };
  }
  const standings = await db
    .select({ guildId: guildSeasonStandings.guildId, rank: guildSeasonStandings.rank })
    .from(guildSeasonStandings)
    .where(eq(guildSeasonStandings.season, number))
    .orderBy(asc(guildSeasonStandings.rank));
  const awards = computeGuildAwards(standings);
  const batch = Math.max(1, options.batch ?? 200);
  let n = 0;
  const step = () => {
    if (options.failAfterBatches !== undefined && n >= options.failAfterBatches) {
      throw new Error(`guild award run stopped after ${n} batches (test)`);
    }
    n += 1;
  };
  if (awards.length > 0) {
    step();
    await db
      .insert(guildSeasonAwards)
      .values(
        awards.map((a) => ({
          season: number,
          guildId: a.guildId,
          tier: a.tier,
          rank: a.rank,
          awardedAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  const tierOf = new Map<string, GuildHonourTier>(awards.map((a) => [a.guildId, a.tier]));
  const roll = (
    await db
      .select({ accountId: guildSeasonRosters.accountId, guildId: guildSeasonRosters.guildId })
      .from(guildSeasonRosters)
      .where(eq(guildSeasonRosters.season, number))
      .orderBy(asc(guildSeasonRosters.accountId))
  ).filter((r) => tierOf.has(r.guildId));
  for (let i = 0; i < roll.length; i += batch) {
    step();
    const slice = roll.slice(i, i + batch);
    await withTransaction(db, async (tx) => {
      for (const r of slice) {
        await grantCosmeticsTx(
          tx,
          { accountId: r.accountId, now, source: `guildSeason:${number}` },
          guildSeasonCosmeticsEarned(tierOf.get(r.guildId)!),
        );
        // Ticket 8.5: the guild's honours in the member's inbox (once; the run is resumable).
        await notifyTx(tx, {
          accountId: r.accountId,
          kind: 'guild.honours',
          data: { season: number, tier: tierOf.get(r.guildId)! },
          now,
          dedupeKey: `guildSeason:${number}`,
        });
      }
    });
  }
  return withTransaction(db, async (tx): Promise<GuildAwardOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(seasonLock(number))})`);
    const [fresh] = await tx.select().from(seasons).where(eq(seasons.number, number)).for('update');
    if (!fresh || fresh.guildAwardedAt) return { kind: 'already' };
    await tx.update(seasons).set({ guildAwardedAt: now }).where(eq(seasons.number, number));
    const counts = new Map<GuildHonourTier, number>();
    for (const a of awards) counts.set(a.tier, (counts.get(a.tier) ?? 0) + 1);
    recordTelemetry(
      tx,
      now,
      [...counts].map(([tier, events]) => ({ metric: 'guild_season.award', dims: [tier], events })),
    );
    await writeAudit(tx, {
      event: 'guild_season.award',
      data: { season: number, guilds: awards.length, members: roll.length },
    });
    return { kind: 'awarded', guilds: awards.length, members: roll.length };
  });
}

export interface GuildCheckReport {
  rows: number;
  wrong: { season: number; guildId: string; table: 'entries' | 'standings' }[];
}

/**
 * The recompute check (`pnpm admin:guild-seasons check`): every stored row's value and key must
 * equal `guildSeasonScore` of its stored input at its version, and its hash must match the input.
 */
export async function checkGuildSeasons(executor: Executor): Promise<GuildCheckReport> {
  const out: GuildCheckReport = { rows: 0, wrong: [] };
  const check = (
    table: 'entries' | 'standings',
    rows: {
      season: number;
      guildId: string;
      formulaVersion: number;
      value: number;
      sortKey: number[];
      inputsHash: string;
      input: GuildSeasonInput;
    }[],
  ) => {
    for (const r of rows) {
      out.rows += 1;
      let ok: boolean;
      try {
        const s = guildSeasonScore(r.input, r.formulaVersion);
        ok =
          s.value === Number(r.value) &&
          sameKey(s.sortKey, r.sortKey) &&
          guildInputsHash(r.input, r.formulaVersion) === r.inputsHash;
      } catch {
        ok = false;
      }
      if (!ok) out.wrong.push({ season: r.season, guildId: r.guildId, table });
    }
  };
  check('entries', await executor.select().from(guildSeasonEntries));
  check('standings', await executor.select().from(guildSeasonStandings));
  return out;
}
