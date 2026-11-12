import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  GUILD_SEASON_FORMULA_VERSION,
  GUILD_SEASON_RULES,
  GUILD_SEASON_WEIGHTS,
  guildSeasonScore,
  type GuildHallDisplay,
  type GuildSeasonInput,
} from '@worldforge/game-core';
import type { Executor } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { listSeasons, seasonView } from '../seasons/model.js';
import type { Season } from '../db/schema.js';
import { blockedEitherWay } from '../social/relations.js';
import { membershipOf } from '../social/guild-model.js';
import { createBoardReadLimiter, DEFAULT_BOARD_READ_LIMIT } from '../leaderboards/routes.js';
import { hallDisplayOf, plainHall } from '../guild-halls/model.js';
import { refreshGuildSeason } from './model.js';

/**
 * The guild roll (ticket 8.4, docs/LEADERBOARDS.md "Guild seasons"): `GET
 * /api/leaderboards/guilds?season=<n>` (default: the season under way, else the latest begun).
 * A live season reads `guild_season_entries`, an archived one `guild_season_standings`.
 *
 * **Privacy (5.2's rules for guilds):** no player is named on the roll (only counts); every listed
 * guild shows its name, tag and emblem; its link (handle) only where the viewer may see the guild
 * (not blocked either way with its leader, docs/SOCIAL.md "Blocks"). Left off at read time: guilds
 * whose leader has an active sanction, guilds under a forced rename, disbanded guilds; on an
 * archive the ranks are kept. Test accounts never count (the churn rules), so a guild of test
 * accounts never has enough counted members to appear.
 */

const leaderOf = sql`(select l.account_id from guild_members l where l.guild_id = g.id and l.role = 'leader')`;
const leaderSanctioned = (at: Date) =>
  sql`exists (select 1 from sanctions s where s.subject_id = ${leaderOf} and s.lifted_at is null
    and s.expires_at > ${at.toISOString()}::timestamptz)`;

type RollRow = {
  guild_id: string;
  handle: string;
  name: string;
  tag: string;
  emblem: string;
  rename_required: boolean;
  leader_id: string | null;
  formula_version: number;
  value: number;
  input: GuildSeasonInput;
  members: number;
  rank: number | null;
  tier: string | null;
};

/** The listed rows of a season's roll, in board order, with ranks. */
async function rollRows(executor: Executor, season: Season, at: Date): Promise<RollRow[]> {
  if (season.archivedAt) {
    if (!season.guildArchivedAt) return [];
    return queryRows<RollRow>(
      executor,
      sql`select st.guild_id, g.handle, st.name, st.tag, st.emblem, g.rename_required,
          ${leaderOf} as leader_id, st.formula_version, st.value, st.input, st.members, st.rank,
          a.tier
        from guild_season_standings st join guilds g on g.id = st.guild_id
          left join guild_season_awards a on a.season = st.season and a.guild_id = st.guild_id
        where st.season = ${season.number} and not ${leaderSanctioned(at)}
        order by st.rank`,
    );
  }
  const rows = await queryRows<RollRow>(
    executor,
    sql`select e.guild_id, g.handle, g.name, g.tag, g.emblem, g.rename_required,
        ${leaderOf} as leader_id, e.formula_version, e.value, e.input, e.members,
        null::int as rank, null::text as tier
      from guild_season_entries e join guilds g on g.id = e.guild_id
      where e.season = ${season.number} and e.value > 0
        and e.members >= ${GUILD_SEASON_RULES.minMembers}
        and g.disbanded_at is null and not g.rename_required and not ${leaderSanctioned(at)}
      order by e.sort_key desc, e.achieved_at asc, e.guild_id asc`,
  );
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface GuildRollEntry {
  rank: number | null;
  guild: {
    handle: string | null;
    name: string;
    tag: string;
    emblem: string;
    look: GuildHallDisplay;
  };
  value: number;
  parts: { boss: number; pve: number; community: number };
  members: number;
  tier: string | null;
}

function entryOf(
  r: RollRow,
  look: GuildHallDisplay | undefined,
  hidden: Set<string>,
): GuildRollEntry {
  const score = guildSeasonScore(r.input, Number(r.formula_version));
  const withheld = r.rename_required;
  return {
    rank: r.rank === null ? null : Number(r.rank),
    guild: {
      handle: withheld || (r.leader_id && hidden.has(r.leader_id)) ? null : r.handle,
      name: withheld ? 'Name withheld' : r.name,
      tag: withheld ? '—' : r.tag,
      emblem: r.emblem,
      look: look ?? plainHall(),
    },
    value: Number(r.value),
    parts: score.parts,
    members: Number(r.members),
    tier: r.tier,
  };
}

/** The guild's own standing in the season under way (or the latest begun), for its hall. */
export async function guildStandingOf(executor: Executor, guildId: string, now: Date) {
  const list = await listSeasons(executor);
  const season = [...list].reverse().find((s) => s.startsAt.getTime() <= now.getTime()) ?? null;
  if (!season) return { season: null, entry: null };
  const rows = await rollRows(executor, season, now);
  const listed = rows.find((r) => r.guild_id === guildId);
  let entry: (GuildRollEntry & { listed: boolean }) | null = null;
  if (listed) {
    entry = { ...entryOf(listed, undefined, new Set()), listed: true };
  } else if (!season.archivedAt) {
    const [own] = await queryRows<RollRow>(
      executor,
      sql`select e.guild_id, g.handle, g.name, g.tag, g.emblem, g.rename_required,
          null::uuid as leader_id, e.formula_version, e.value, e.input, e.members,
          null::int as rank, null::text as tier
        from guild_season_entries e join guilds g on g.id = e.guild_id
        where e.season = ${season.number} and e.guild_id = ${guildId}`,
    );
    if (own) entry = { ...entryOf(own, undefined, new Set()), listed: false };
  }
  return { season: seasonView(season, now), entry };
}

interface RollQuery {
  Querystring: { season?: number; offset?: number; limit?: number };
}

export async function registerGuildSeasons(
  app: FastifyInstance,
  activity: ActivityOptions,
  options: { readLimit?: { max: number; windowMs: number } | undefined } = {},
): Promise<void> {
  const checkRead = createBoardReadLimiter(
    app,
    options.readLimit ?? DEFAULT_BOARD_READ_LIMIT,
    'guildBoards',
  );
  app.get<RollQuery>(
    '/leaderboards/guilds',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            season: { type: 'integer', minimum: 1, maximum: 100_000 },
            offset: { type: 'integer', minimum: 0, maximum: 100_000 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account.id;
      await checkRead(me, reply);
      const now = activity.now();
      const list = await listSeasons(app.db);
      const begun = list.filter((s) => s.startsAt.getTime() <= now.getTime());
      const pick =
        request.query.season !== undefined
          ? begun.find((s) => s.number === request.query.season)
          : begun.at(-1);
      if (request.query.season !== undefined && !pick)
        throw new ApiError(404, 'season_not_found', 'No such season (or it has not begun).');
      const mine = await membershipOf(app.db, me);
      // The viewer's own guild is brought up to date first (like 5.2's viewer backfill).
      if (mine && pick && !pick.archivedAt)
        await refreshGuildSeason(app.db, now, app.authNow(), [mine.guild.id]);
      const rows = pick ? await rollRows(app.db, pick, app.authNow()) : [];
      const offset = request.query.offset ?? 0;
      const limit = request.query.limit ?? 25;
      const page = rows.slice(offset, offset + limit);
      const ownRow = mine ? rows.find((r) => r.guild_id === mine.guild.id) : undefined;
      const shown = [...page, ...(ownRow && !page.includes(ownRow) ? [ownRow] : [])];
      const hidden = await blockedEitherWay(
        app.db,
        me,
        shown.map((r) => r.leader_id).filter((x): x is string => !!x),
      );
      const looks = await hallDisplayOf(
        app.db,
        shown.map((r) => r.guild_id),
      );
      const own = mine && pick ? await guildStandingOf(app.db, mine.guild.id, now) : null;
      return {
        season: pick ? seasonView(pick, now) : null,
        formula: {
          version: GUILD_SEASON_FORMULA_VERSION,
          weights: GUILD_SEASON_WEIGHTS[GUILD_SEASON_FORMULA_VERSION],
          rules: { ...GUILD_SEASON_RULES },
        },
        total: rows.length,
        offset,
        entries: page.map((r) => entryOf(r, looks.get(r.guild_id), hidden)),
        mine: ownRow
          ? { ...entryOf(ownRow, looks.get(ownRow.guild_id), new Set()), listed: true }
          : (own?.entry ?? null),
      };
    },
  );
}
