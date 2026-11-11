import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  BRACKET_POWER_VERSION,
  DUEL_OFFER_REFRESH_MS,
  PAIR_FACTORS,
  PAIR_WINDOW_MS,
  PROVISIONAL_GAMES,
  PVP_RULES_VERSION,
  bracketPower,
  expectedScore,
  matchOdds,
  ratingStanding,
  type MatchOdds,
  type RatingStanding,
  RATED_DUELS_PER_DAY,
  RATED_DUEL_MIN_LEVEL,
  duelDay,
  duelDecision,
  duelFighter,
  findPvpBracket,
  friendlyBracket,
  nextDuelDayAt,
  normaliseFighter,
  pvpBracketOf,
  ratedBracketId,
  ratedDuelsOpen,
  simulateDuel,
  type ClassId,
  type DuelEndReason,
  type DuelEvent,
  type DuelKind,
  type DuelOutcome,
  type DuelSide,
  type DuelSnapshot,
  type ItemRejection,
  type StatBlock,
} from '@worldforge/game-core';
import { duelDefences, duelOffers, duels, type Duel } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { recordTelemetry } from '../telemetry/record.js';
import { assertSocialWriteAllowed } from '../social/social-write.js';
import { blockedEitherWay, friendIds, relationBetween } from '../social/relations.js';
import { areGuildmates, guildmateIds } from '../social/guild-model.js';
import {
  arenaPeople,
  drawOpponents,
  heroDuelSnapshot,
  lockDuelAccount,
  lockOwnHeroShared,
  ownHero,
  ratedDuelsOn,
  sanctionedAmong,
  type ArenaHeroView,
  type ArenaPlayerView,
} from './model.js';
import {
  applyRatedDuel,
  ratingSeasonAt,
  ratingsFor,
  ratingView,
  shareSignal,
  type RatingView,
} from './rating.js';
import { ladderRankOf, registerLadder } from './ladder.js';
import { registerArenaPatterns } from './patterns.js';
import { seasonView, type SeasonView } from '../seasons/model.js';

/**
 * The arena (ticket 5.5, docs/PVP.md "The arena"): defences, rated duels against a server-offered
 * list, friendly challenges with friends and guildmates, results with their log, and the history.
 * Every duel resolves at once with `simulateDuel` from a server-only seed and the stored
 * snapshots; it changes nothing a player owns (no gold, items, XP or score). Ticket 5.6: a rated
 * duel in a season moves both heroes' ratings in its transaction (`rating.ts`), opponent lists
 * come from matchmaking (`drawOpponents`), and friends, guildmates and accounts sharing a sign-up
 * signal never meet in a rated duel.
 */

export interface DefenceView {
  defenceId: string;
  heroName: string;
  classId: ClassId;
  level: number;
  bracketId: string;
  setAt: string;
  /** Items stored (each passed 5.1's checks). */
  items: number;
  /** Why the other worn items count nothing (forged, invalid or misplaced). */
  rejected: ItemRejection[];
  /** The hero's level moved on since (refresh to fight as the hero is now). */
  outdated: boolean;
}

export interface OpponentView {
  defenceId: string;
  player: ArenaPlayerView;
  hero: ArenaHeroView;
  bracketId: string;
  /** The day the defence was set (no finer time leaves the server). */
  setOn: string;
  /** Ticket 5.6: the defender's rating this season (rounded) and its certainty. */
  rating: { rating: number; standing: RatingStanding };
  /** Your chances by both ratings, in plain words. */
  odds: MatchOdds;
}

export interface ArenaStateResponse {
  now: string;
  day: { key: string; resetsAt: string };
  rules: {
    ratedPerDay: number;
    minLevel: number;
    rulesVersion: number;
    offerRefreshMs: number;
    /** Ticket 5.6: rated duels before a rating is ranked; the repeat-pair factors and window. */
    provisionalGames: number;
    pairFactors: readonly number[];
    pairWindowDays: number;
  };
  /** Ticket 5.6: the season's ladder as this hero stands on it. */
  ladder: {
    /** The season rated duels count in now (null: none under way; duels then move no rating). */
    season: SeasonView | null;
    you: RatingView;
    /** The hero's place on the ladder (null while provisional or without a season). */
    rank: number | null;
  };
  hero: {
    characterId: string;
    name: string;
    classId: ClassId;
    level: number;
    bracket: { id: string; label: string };
    ratedOpen: boolean;
  };
  defence: DefenceView | null;
  rated: {
    used: number;
    left: number;
    /** Null until the first list is drawn (`POST /arena/opponents`). */
    offer: { offeredAt: string; refreshableAt: string; opponents: OpponentView[] } | null;
  };
}

export interface DuelSideView {
  player: ArenaPlayerView | null;
  /** A player blocked either way since (their name is not shown). */
  blocked: boolean;
  hero: ArenaHeroView;
  maxHealth: number;
  health: number;
  attacks: number;
  crits: number;
  damageDealt: number;
  /** The normalised stats the duel was fought with. */
  stats: StatBlock;
  /** Your own side only: your PvE stats from the stored snapshot ("812 health counts as 640"). */
  pveStats: StatBlock | null;
}

export interface DuelView {
  id: string;
  kind: DuelKind;
  bracketId: string;
  bracketLabel: string;
  rulesVersion: number;
  you: DuelSide;
  /** From the viewer's side. */
  result: 'won' | 'lost' | 'draw';
  outcome: DuelOutcome;
  reason: DuelEndReason;
  durationMs: number;
  foughtAt: string;
  defenceSetOn: string;
  challenger: DuelSideView;
  defender: DuelSideView;
  events: DuelEvent[];
  /**
   * Ticket 5.6: what this rated duel did to the viewer's rating (null for friendly duels and for
   * rated duels that moved no rating: `unrated`).
   */
  rating: {
    season: number;
    before: number;
    after: number;
    change: number;
    /** The repeat-pair factor (1 = full, 0 = counted for nothing). */
    factor: number;
  } | null;
  /**
   * A rated duel that moved no rating: no season was under way (or it was fought before the
   * ladder opened, ticket 5.6). It still counted toward the day's ten.
   */
  unrated: boolean;
}

export interface DuelSummaryView {
  id: string;
  kind: DuelKind;
  you: DuelSide;
  result: 'won' | 'lost' | 'draw';
  bracketId: string;
  foughtAt: string;
  yourHero: ArenaHeroView;
  opponent: { player: ArenaPlayerView | null; blocked: boolean; hero: ArenaHeroView };
}

export interface FriendlyOpponentView {
  player: ArenaPlayerView;
  relation: 'friend' | 'guildmate';
  defences: {
    defenceId: string;
    hero: ArenaHeroView;
    bracketId: string;
    setOn: string;
  }[];
}

const uuid = { type: 'string', format: 'uuid' } as const;
const heroBody = {
  type: 'object',
  additionalProperties: false,
  required: ['characterId'],
  properties: { characterId: uuid },
} as const;
const duelBody = {
  type: 'object',
  additionalProperties: false,
  required: ['characterId', 'defenceId', 'kind'],
  properties: {
    characterId: uuid,
    defenceId: uuid,
    kind: { type: 'string', enum: ['rated', 'friendly'] },
  },
} as const;
const heroQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['characterId'],
  properties: { characterId: uuid },
} as const;
const historyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 64 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const;
const duelParams = {
  type: 'object',
  required: ['duelId'],
  properties: { duelId: uuid },
} as const;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const bracketLabel = (id: string) => findPvpBracket(id)?.label ?? id;

function defenceView(d: typeof duelDefences.$inferSelect, hero: { level: number }): DefenceView {
  return {
    defenceId: d.id,
    heroName: d.snapshot.heroName,
    classId: d.classId,
    level: d.level,
    bracketId: d.bracketId,
    setAt: d.setAt.toISOString(),
    items: d.snapshot.equipment.length,
    rejected: [...d.snapshot.rejected],
    outdated: hero.level !== d.level,
  };
}

/** The arena as one hero of the viewer sees it. */
export async function arenaState(
  db: Executor,
  accountId: string,
  characterId: string,
  now: Date,
  authNow: Date,
): Promise<ArenaStateResponse> {
  const hero = await ownHero(db, accountId, characterId);
  const bracket = pvpBracketOf(hero.level);
  const day = duelDay(now);
  const [defence] = await db
    .select()
    .from(duelDefences)
    .where(eq(duelDefences.characterId, hero.id));
  const [offer] = await db.select().from(duelOffers).where(eq(duelOffers.characterId, hero.id));
  const used = await ratedDuelsOn(db, accountId, day);

  let offerView: ArenaStateResponse['rated']['offer'] = null;
  if (offer) {
    // Read-time filter: a block, a sanction, a bracket move or a deleted defence since the draw
    // takes the opponent off the list (the duel route checks again under its locks).
    const rows =
      offer.defenceIds.length === 0
        ? []
        : await db.select().from(duelDefences).where(inArray(duelDefences.id, offer.defenceIds));
    const owners = rows.map((r) => r.accountId);
    const [blocked, sanctioned] = await Promise.all([
      blockedEitherWay(db, accountId, owners),
      sanctionedAmong(db, owners, authNow),
    ]);
    const live = rows.filter(
      (r) =>
        !blocked.has(r.accountId) &&
        !sanctioned.has(r.accountId) &&
        r.bracketId === offer.bracketId &&
        r.accountId !== accountId,
    );
    const people = await arenaPeople(
      db,
      accountId,
      live.map((r) => r.accountId),
      live.map((r) => r.characterId),
      authNow,
    );
    const order = new Map(offer.defenceIds.map((id, i) => [id, i]));
    const offerSeason = await ratingSeasonAt(db, now);
    const offerRatings = await ratingsFor(db, offerSeason?.number ?? null, [
      hero.id,
      ...live.map((r) => r.characterId),
    ]);
    const mineRating = offerRatings.get(hero.id)!.rating;
    offerView = {
      offeredAt: offer.offeredAt.toISOString(),
      refreshableAt: new Date(offer.offeredAt.getTime() + DUEL_OFFER_REFRESH_MS).toISOString(),
      opponents: live
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
        .flatMap((r) => {
          const player = people.player(r.accountId);
          if (!player) return [];
          return [
            {
              defenceId: r.id,
              player,
              hero: people.hero(r.accountId, r.characterId, {
                name: r.snapshot.heroName,
                classId: r.classId,
                level: r.level,
              }),
              bracketId: r.bracketId,
              setOn: dayOf(r.setAt),
              rating: (() => {
                const t = offerRatings.get(r.characterId)!;
                return {
                  rating: Math.round(t.rating.rating),
                  standing: ratingStanding(t.rating, t.row?.games ?? 0),
                };
              })(),
              odds: matchOdds(expectedScore(mineRating, offerRatings.get(r.characterId)!.rating)),
            },
          ];
        }),
    };
  }

  const season = await ratingSeasonAt(db, now);
  const own = (await ratingsFor(db, season?.number ?? null, [hero.id])).get(hero.id)!;
  let rank: number | null = null;
  if (season && own.row && own.row.games >= PROVISIONAL_GAMES) {
    rank = await ladderRankOf(db, season.number, own.row, authNow);
  }
  return {
    now: now.toISOString(),
    day: { key: day, resetsAt: nextDuelDayAt(now).toISOString() },
    rules: {
      ratedPerDay: RATED_DUELS_PER_DAY,
      minLevel: RATED_DUEL_MIN_LEVEL,
      rulesVersion: PVP_RULES_VERSION,
      offerRefreshMs: DUEL_OFFER_REFRESH_MS,
      provisionalGames: PROVISIONAL_GAMES,
      pairFactors: PAIR_FACTORS,
      pairWindowDays: Math.round(PAIR_WINDOW_MS / 86_400_000),
    },
    ladder: {
      season: season ? seasonView(season, now) : null,
      you: ratingView(own.rating, own.row),
      rank,
    },
    hero: {
      characterId: hero.id,
      name: hero.name,
      classId: hero.classId,
      level: hero.level,
      bracket: { id: bracket.id, label: bracket.label },
      ratedOpen: ratedDuelsOpen(hero.level),
    },
    defence: defence ? defenceView(defence, hero) : null,
    rated: {
      used,
      left: Math.max(0, RATED_DUELS_PER_DAY - used),
      offer: offerView,
    },
  };
}

const resultFor = (outcome: DuelOutcome, you: DuelSide): DuelView['result'] =>
  outcome === 'draw' ? 'draw' : outcome === you ? 'won' : 'lost';

/** A stored duel as one of its two players sees it. */
export async function duelView(
  db: Executor,
  viewerId: string,
  duel: Duel,
  now: Date,
): Promise<DuelView> {
  const you: DuelSide = duel.challengerAccountId === viewerId ? 'challenger' : 'defender';
  const people = await arenaPeople(
    db,
    viewerId,
    [duel.challengerAccountId, duel.defenderAccountId].filter((x): x is string => x !== null),
    [duel.challengerCharacterId, duel.defenderCharacterId].filter((x): x is string => x !== null),
    now,
  );
  const side = (s: DuelSide): DuelSideView => {
    const accountId = s === 'challenger' ? duel.challengerAccountId : duel.defenderAccountId;
    const characterId = s === 'challenger' ? duel.challengerCharacterId : duel.defenderCharacterId;
    const snap: DuelSnapshot = s === 'challenger' ? duel.challengerSnapshot : duel.defenderSnapshot;
    const r = duel.sides[s];
    const own = s === you;
    return {
      player: own ? null : people.player(accountId),
      blocked: !own && people.blocked(accountId),
      hero: people.hero(accountId, characterId, {
        name: snap.heroName,
        classId: snap.classId,
        level: snap.level,
      }),
      maxHealth: r.maxHealth,
      health: r.health,
      attacks: r.attacks,
      crits: r.crits,
      damageDealt: r.damageDealt,
      stats: r.stats,
      pveStats: own
        ? normaliseFighter(
            duelFighter(snap),
            findPvpBracket(duel.bracketId) ?? pvpBracketOf(snap.level),
          ).pveStats
        : null,
    };
  };
  return {
    id: duel.id,
    kind: duel.kind,
    bracketId: duel.bracketId,
    bracketLabel: bracketLabel(duel.bracketId),
    rulesVersion: duel.rulesVersion,
    you,
    result: resultFor(duel.outcome, you),
    outcome: duel.outcome,
    reason: duel.reason as DuelEndReason,
    durationMs: duel.durationMs,
    foughtAt: duel.foughtAt.toISOString(),
    defenceSetOn: dayOf(duel.defenceSetAt),
    challenger: side('challenger'),
    defender: side('defender'),
    events: duel.events,
    rating: duel.rating
      ? (() => {
          const mine = duel.rating[you];
          const before = Math.round(mine.before.rating);
          const after = Math.round(mine.after.rating);
          return {
            season: duel.rating.season,
            before,
            after,
            change: after - before,
            factor: duel.rating.factor,
          };
        })()
      : null,
    unrated: duel.kind === 'rated' && !duel.rating,
  };
}

const encodeCursor = (d: Duel) => `${d.foughtAt.getTime()}.${d.id}`;
function decodeCursor(raw: string): { ms: number; id: string } {
  const m = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(raw);
  if (!m)
    throw new ApiError(400, 'validation_failed', 'Unknown cursor.', {
      fields: { cursor: 'unknown' },
    });
  return { ms: Number(m[1]), id: m[2]! };
}

export async function registerArena(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  await registerLadder(app, { now: activity.now });
  await registerArenaPatterns(app, { now: activity.now });
  app.get<{ Querystring: { characterId: string } }>(
    '/arena',
    { preHandler: app.requireAccount, schema: { querystring: heroQuery } },
    async (request) =>
      arenaState(
        app.db,
        request.auth!.account.id,
        request.query.characterId,
        activity.now(),
        app.authNow(),
      ),
  );

  // Set or refresh a hero's defence: a snapshot of what it wears now (any level).
  app.post(
    '/arena/defence',
    { preHandler: app.requireAccount, schema: { body: heroBody } },
    async (request): Promise<ArenaStateResponse> => {
      const me = request.auth!.account.id;
      const { characterId } = request.body as { characterId: string };
      return withTransaction(app.db, async (tx) => {
        const now = activity.now();
        const hero = await lockOwnHeroShared(tx, me, characterId);
        const snapshot = await heroDuelSnapshot(tx, hero);
        const bracket = pvpBracketOf(hero.level);
        const bracketId = bracket.id;
        // Ticket 5.6: the snapshot's bracket Power, for matchmaking (~2 ms).
        const power = bracketPower(duelFighter(snapshot), bracket);
        const [row] = await tx
          .insert(duelDefences)
          .values({
            id: uuidv7(),
            characterId: hero.id,
            accountId: me,
            classId: hero.classId,
            level: hero.level,
            bracketId,
            rulesVersion: PVP_RULES_VERSION,
            snapshot,
            setAt: now,
            power,
            powerVersion: BRACKET_POWER_VERSION,
          })
          .onConflictDoUpdate({
            target: duelDefences.characterId,
            set: {
              classId: hero.classId,
              level: hero.level,
              bracketId,
              rulesVersion: PVP_RULES_VERSION,
              snapshot,
              setAt: now,
              power,
              powerVersion: BRACKET_POWER_VERSION,
            },
          })
          .returning();
        await writeAudit(tx, {
          event: 'duel.defence',
          accountId: me,
          characterId: hero.id,
          data: {
            defenceId: row!.id,
            level: hero.level,
            bracketId,
            items: snapshot.equipment.length,
            rejected: snapshot.rejected,
          },
        });
        return arenaState(tx, me, hero.id, now, app.authNow());
      });
    },
  );

  // Draw a fresh rated opponent list (at most every 5 minutes, or once the list is used up).
  app.post(
    '/arena/opponents',
    { preHandler: app.requireAccount, schema: { body: heroBody } },
    async (request, reply): Promise<ArenaStateResponse> => {
      const me = request.auth!.account.id;
      const { characterId } = request.body as { characterId: string };
      return withTransaction(app.db, async (tx) => {
        const now = activity.now();
        await lockDuelAccount(tx, me);
        const hero = await lockOwnHeroShared(tx, me, characterId);
        if (!ratedDuelsOpen(hero.level)) {
          const r = duelDecision('rated', {
            relation: 'stranger',
            guildmate: false,
            defenderSanctioned: false,
            challengerLevel: hero.level,
            defenderLevel: hero.level,
            ratedToday: 0,
          });
          if (r !== 'allowed') throw new ApiError(r.status, r.code, r.message);
        }
        const [current] = await tx
          .select()
          .from(duelOffers)
          .where(eq(duelOffers.characterId, hero.id));
        const bracketId = ratedBracketId(hero.level);
        if (
          current &&
          current.bracketId === bracketId &&
          current.defenceIds.length > 0 &&
          now.getTime() - current.offeredAt.getTime() < DUEL_OFFER_REFRESH_MS
        ) {
          const waitMs = current.offeredAt.getTime() + DUEL_OFFER_REFRESH_MS - now.getTime();
          const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
          void reply.header('retry-after', String(retryAfterSeconds));
          throw new ApiError(
            409,
            'offer_fresh',
            'These opponents are still fresh. Fight one, or ask again in a few minutes.',
            { retryAfterSeconds },
          );
        }
        // Ticket 5.6: matchmaking by bracket Power range and rating, from a server-only seed.
        const draw = await drawOpponents(
          tx,
          me,
          { characterId: hero.id, snapshot: await heroDuelSnapshot(tx, hero) },
          bracketId,
          now,
          app.authNow(),
          randomBytes(16).toString('hex'),
        );
        const defenceIds = draw.defenceIds;
        recordTelemetry(tx, now, [
          {
            metric: 'arena.offer',
            dims: [bracketId, draw.powerStep === null ? 'none' : `range${draw.widened}`],
            amount: defenceIds.length,
          },
        ]);
        await tx
          .insert(duelOffers)
          .values({ characterId: hero.id, accountId: me, bracketId, defenceIds, offeredAt: now })
          .onConflictDoUpdate({
            target: duelOffers.characterId,
            set: { bracketId, defenceIds, offeredAt: now },
          });
        return arenaState(tx, me, hero.id, now, app.authNow());
      });
    },
  );

  // Fight a duel: a rated one against an offered defence, or a friendly challenge.
  app.post(
    '/arena/duels',
    { preHandler: app.requireAccount, schema: { body: duelBody } },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const { characterId, defenceId, kind } = request.body as {
        characterId: string;
        defenceId: string;
        kind: DuelKind;
      };
      await app.socialWriteLimit(me, reply);
      return idempotentTransaction<{ duel: DuelView }>(
        app,
        request,
        reply,
        { now: activity.now, status: 201 },
        async (tx) => {
          const now = activity.now();
          const authNow = app.authNow();
          await assertSocialWriteAllowed(tx, me, 'duel', authNow);
          await lockDuelAccount(tx, me);
          const hero = await lockOwnHeroShared(tx, me, characterId);
          // Only an opponent the server offered this hero (never an id the client chose). Ticket
          // 5.8: checked first, so an id off the list answers the same whatever it names (a block,
          // a sanction or nothing at all).
          const offered =
            kind === 'rated'
              ? (
                  await tx
                    .select()
                    .from(duelOffers)
                    .where(eq(duelOffers.characterId, hero.id))
                    .for('update')
                )[0]
              : undefined;
          if (kind === 'rated' && !offered?.defenceIds.includes(defenceId))
            throw new ApiError(
              404,
              'not_offered',
              'That opponent is not on your list. Ask for a fresh list.',
            );
          const [defence] = await tx
            .select()
            .from(duelDefences)
            .where(eq(duelDefences.id, defenceId))
            .for('share');
          if (!defence) throw new ApiError(404, 'not_found', 'No such opponent.');
          const day = duelDay(now);
          const relation =
            defence.accountId === me ? 'self' : await relationBetween(tx, me, defence.accountId);
          const decision = duelDecision(kind, {
            relation,
            guildmate: await areGuildmates(tx, me, defence.accountId),
            defenderSanctioned: (await sanctionedAmong(tx, [defence.accountId], authNow)).has(
              defence.accountId,
            ),
            challengerLevel: hero.level,
            defenderLevel: defence.level,
            ratedToday: kind === 'rated' ? await ratedDuelsOn(tx, me, day) : 0,
            sharedSignal: kind === 'rated' ? await shareSignal(tx, me, defence.accountId) : false,
          });
          if (decision !== 'allowed')
            throw new ApiError(decision.status, decision.code, decision.message);

          const challengerSnapshot = await heroDuelSnapshot(tx, hero);
          const bracketId =
            kind === 'rated'
              ? ratedBracketId(hero.level)
              : friendlyBracket(hero.level, defence.level).id;
          // The server-only secret of this duel (never from a client, never sent to one).
          const seed = randomBytes(16).toString('hex');
          const fight = simulateDuel({
            challenger: duelFighter(challengerSnapshot),
            defender: duelFighter(defence.snapshot),
            seed,
            bracketId,
          });
          // Ticket 5.6: both ratings move inside this transaction (season, pair, hero locks).
          const rating =
            kind === 'rated'
              ? await applyRatedDuel(tx, {
                  challenger: {
                    accountId: me,
                    characterId: hero.id,
                    classId: hero.classId,
                    level: hero.level,
                    bracketId,
                  },
                  defender: {
                    accountId: defence.accountId,
                    characterId: defence.characterId,
                    classId: defence.classId,
                    level: defence.level,
                    bracketId,
                  },
                  outcome: fight.outcome,
                  now,
                })
              : null;
          const [row] = await tx
            .insert(duels)
            .values({
              id: uuidv7(),
              kind,
              challengerAccountId: me,
              challengerCharacterId: hero.id,
              defenderAccountId: defence.accountId,
              defenderCharacterId: defence.characterId,
              defenceId: defence.id,
              bracketId,
              day,
              seed,
              rulesVersion: fight.rulesVersion,
              challengerSnapshot,
              defenderSnapshot: defence.snapshot,
              defenceSetAt: defence.setAt,
              outcome: fight.outcome,
              reason: fight.reason,
              durationMs: fight.durationMs,
              sides: fight.sides,
              events: fight.events,
              foughtAt: now,
              rating,
            })
            .returning();
          if (kind === 'rated') {
            // A fought opponent leaves the list (a fresh one can be drawn at once when it is empty).
            await tx
              .update(duelOffers)
              .set({ defenceIds: sql`array_remove(${duelOffers.defenceIds}, ${defence.id}::uuid)` })
              .where(eq(duelOffers.characterId, hero.id));
          }
          await writeAudit(tx, {
            event: 'duel.fight',
            accountId: me,
            characterId: hero.id,
            data: {
              duelId: row!.id,
              kind,
              bracketId,
              defenderAccountId: defence.accountId,
              defenceId: defence.id,
              outcome: fight.outcome,
              reason: fight.reason,
              rulesVersion: fight.rulesVersion,
              day,
              ...(rating
                ? {
                    rating: {
                      season: rating.season,
                      factor: rating.factor,
                      challenger: Math.round(
                        rating.challenger.after.rating - rating.challenger.before.rating,
                      ),
                      defender: Math.round(
                        rating.defender.after.rating - rating.defender.before.rating,
                      ),
                    },
                  }
                : {}),
            },
          });
          recordTelemetry(tx, now, [
            { metric: 'duel.fight', dims: [kind, bracketId, fight.outcome] },
            ...(kind === 'rated'
              ? [
                  {
                    metric: 'arena.rated' as const,
                    dims: [
                      bracketId,
                      !rating
                        ? 'no_season'
                        : rating.factor === 1
                          ? 'full'
                          : rating.factor > 0
                            ? 'reduced'
                            : 'none',
                    ],
                  },
                ]
              : []),
          ]);
          return { duel: await duelView(tx, me, row!, authNow) };
        },
      );
    },
  );

  // The account's duels, newest first: attacking and defending, rated and friendly.
  app.get<{ Querystring: { cursor?: string; limit: number } }>(
    '/arena/duels',
    { preHandler: app.requireAccount, schema: { querystring: historyQuery } },
    async (request): Promise<{ duels: DuelSummaryView[]; nextCursor: string | null }> => {
      const me = request.auth!.account.id;
      const { cursor, limit } = request.query;
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await app.db
        .select()
        .from(duels)
        .where(
          and(
            or(eq(duels.challengerAccountId, me), eq(duels.defenderAccountId, me)),
            after
              ? or(
                  lt(duels.foughtAt, new Date(after.ms)),
                  and(eq(duels.foughtAt, new Date(after.ms)), lt(duels.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(duels.foughtAt), desc(duels.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const people = await arenaPeople(
        app.db,
        me,
        page.flatMap((d) =>
          [d.challengerAccountId, d.defenderAccountId].filter((x): x is string => x !== null),
        ),
        page.flatMap((d) =>
          [d.challengerCharacterId, d.defenderCharacterId].filter((x): x is string => x !== null),
        ),
        app.authNow(),
      );
      return {
        duels: page.map((d) => {
          const you: DuelSide = d.challengerAccountId === me ? 'challenger' : 'defender';
          const mine = you === 'challenger' ? d.challengerSnapshot : d.defenderSnapshot;
          const theirs = you === 'challenger' ? d.defenderSnapshot : d.challengerSnapshot;
          const theirAccount = you === 'challenger' ? d.defenderAccountId : d.challengerAccountId;
          const theirHero = you === 'challenger' ? d.defenderCharacterId : d.challengerCharacterId;
          return {
            id: d.id,
            kind: d.kind,
            you,
            result: resultFor(d.outcome, you),
            bracketId: d.bracketId,
            foughtAt: d.foughtAt.toISOString(),
            yourHero: people.hero(
              me,
              you === 'challenger' ? d.challengerCharacterId : d.defenderCharacterId,
              {
                name: mine.heroName,
                classId: mine.classId,
                level: mine.level,
              },
            ),
            opponent: {
              player: people.player(theirAccount),
              blocked: people.blocked(theirAccount),
              hero: people.hero(theirAccount, theirHero, {
                name: theirs.heroName,
                classId: theirs.classId,
                level: theirs.level,
              }),
            },
          };
        }),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
      };
    },
  );

  // One duel with its log, for either of its two players (anyone else: 404).
  app.get<{ Params: { duelId: string } }>(
    '/arena/duels/:duelId',
    { preHandler: app.requireAccount, schema: { params: duelParams } },
    async (request): Promise<{ duel: DuelView }> => {
      const me = request.auth!.account.id;
      const [duel] = await app.db
        .select()
        .from(duels)
        .where(
          and(
            eq(duels.id, request.params.duelId),
            or(eq(duels.challengerAccountId, me), eq(duels.defenderAccountId, me)),
          ),
        );
      if (!duel) throw new ApiError(404, 'not_found', 'No such duel.');
      return { duel: await duelView(app.db, me, duel, app.authNow()) };
    },
  );

  // Friends and guildmates with a defence (never blocked either way, never sanctioned).
  app.get(
    '/arena/friendly',
    { preHandler: app.requireAccount },
    async (request): Promise<{ opponents: FriendlyOpponentView[] }> => {
      const me = request.auth!.account.id;
      const now = app.authNow();
      const [friends, mates] = await Promise.all([friendIds(app.db, me), guildmateIds(app.db, me)]);
      const friendSet = new Set(friends);
      const ids = [...new Set([...friends, ...mates])].filter((id) => id !== me);
      const [blocked, sanctioned] = await Promise.all([
        blockedEitherWay(app.db, me, ids),
        sanctionedAmong(app.db, ids, now),
      ]);
      const open = ids.filter((id) => !blocked.has(id) && !sanctioned.has(id));
      const rows =
        open.length === 0
          ? []
          : await app.db
              .select({ defence: duelDefences })
              .from(duelDefences)
              .where(inArray(duelDefences.accountId, open))
              .orderBy(desc(duelDefences.level), duelDefences.id);
      const people = await arenaPeople(
        app.db,
        me,
        open,
        rows.map((r) => r.defence.characterId),
        now,
      );
      const byAccount = new Map<string, FriendlyOpponentView>();
      for (const id of open) {
        const player = people.player(id);
        if (!player) continue;
        byAccount.set(id, {
          player,
          relation: friendSet.has(id) ? 'friend' : 'guildmate',
          defences: [],
        });
      }
      for (const { defence: d } of rows) {
        byAccount.get(d.accountId)?.defences.push({
          defenceId: d.id,
          hero: people.hero(d.accountId, d.characterId, {
            name: d.snapshot.heroName,
            classId: d.classId,
            level: d.level,
          }),
          bracketId: d.bracketId,
          setOn: dayOf(d.setAt),
        });
      }
      const opponents = [...byAccount.values()].sort(
        (a, b) =>
          Number(b.defences.length > 0) - Number(a.defences.length > 0) ||
          (a.player.displayName ?? '').localeCompare(b.player.displayName ?? '') ||
          a.player.handle.localeCompare(b.player.handle),
      );
      return { opponents };
    },
  );
}
