import { heroPalettes } from '../cosmetics/display.js';
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  BRACKET_POWER_VERSION,
  DUEL_OFFER_SIZE,
  RATED_DUEL_MIN_LEVEL,
  bracketPower,
  canViewProfile,
  duelFighter,
  duelSnapshot,
  findPvpBracket,
  pickOpponents,
  pvpBracketOf,
  type ClassId,
  type DuelSnapshot,
  type ProfileRelation,
  type ScoredItem,
} from '@worldforge/game-core';
import {
  accounts,
  characters,
  duelDefences,
  duels,
  itemInstances,
  type Character,
} from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { ApiError } from '../errors.js';
import { blockedEitherWay, relationsFor } from '../social/relations.js';
import { profileRelationsFor } from '../social/profiles.js';
import { hiddenTargetKeys } from '../social/sanctions.js';
import { characterNameKey, profileFieldKey } from '../social/targets.js';
import { pairCountsWith, ratedExclusions, ratingSeasonAt, ratingsFor } from './rating.js';

/**
 * The arena model (ticket 5.5, docs/PVP.md "The arena"). Locks, in order, for a duel: the account
 * row (share, `assertSocialWriteAllowed`) → the account's duel lock (`lockDuelAccount`: one
 * account's duels run one at a time, so the daily count is exact) → the challenger's hero (share:
 * an equip waits, so the attack snapshot is one consistent set) → the defence row (share: a
 * refresh waits for the duel, or lands before it; either way the duel uses one stored snapshot).
 * Nothing here settles farming or touches gold, items or XP: a duel changes nothing a player owns.
 */

/** Inside a transaction: the account's duel lock (transaction-scoped advisory lock). */
export async function lockDuelAccount(tx: Executor, accountId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`duel:${accountId}`}, 0))`);
}

/**
 * An own hero, share-locked (an equip, which locks the hero for update, waits until the snapshot
 * is taken). Never settles farming: the arena changes nothing a hero holds.
 */
export async function lockOwnHeroShared(
  tx: Executor,
  accountId: string,
  characterId: string,
): Promise<Character> {
  const [hero] = await tx
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.accountId, accountId),
        isNull(characters.deletedAt),
      ),
    )
    .for('share');
  if (!hero) throw new ApiError(404, 'not_found', 'No such character.');
  return hero;
}

/** The hero's own hero, unlocked (reads). */
export async function ownHero(
  db: Executor,
  accountId: string,
  characterId: string,
): Promise<Character> {
  const [hero] = await db
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.accountId, accountId),
        isNull(characters.deletedAt),
      ),
    );
  if (!hero) throw new ApiError(404, 'not_found', 'No such character.');
  return hero;
}

/** The columns that identify an item inside a stored snapshot (snapshots carry no item ids). */
export interface DefenceItemKey {
  seed: number;
  baseId: string;
  rarityId: string;
  itemLevel: number;
}

const sameItem = (a: DefenceItemKey, b: DefenceItemKey) =>
  a.seed === b.seed &&
  a.baseId === b.baseId &&
  a.rarityId === b.rarityId &&
  a.itemLevel === b.itemLevel;

/**
 * Ticket T.7: items leaving a hero's account (a trade's swap, a moderator's reversal) leave its
 * stored defence too, in the same transaction, so an item never fights for an account that no
 * longer owns it. Everything else about the defence stays as the player saved it (the rest of the
 * gear, the level, when it was set): the slot is empty until the player refreshes. The bracket
 * Power is recomputed for matchmaking. Locks the defence row for update after the caller's hero
 * and item rows (a duel takes the challenger's hero, then the defence: the same direction).
 * Returns how many snapshot items were removed (0 when the hero has no defence or none matched).
 */
export async function withdrawFromDefence(
  tx: Executor,
  characterId: string,
  items: readonly DefenceItemKey[],
): Promise<number> {
  if (items.length === 0) return 0;
  const [defence] = await tx
    .select()
    .from(duelDefences)
    .where(eq(duelDefences.characterId, characterId))
    .for('update');
  if (!defence) return 0;
  const equipment = defence.snapshot.equipment.filter((e) => !items.some((i) => sameItem(e, i)));
  const removed = defence.snapshot.equipment.length - equipment.length;
  if (removed === 0) return 0;
  const snapshot: DuelSnapshot = { ...defence.snapshot, equipment };
  const bracket = findPvpBracket(defence.bracketId) ?? pvpBracketOf(snapshot.level);
  await tx
    .update(duelDefences)
    .set({
      snapshot,
      power: bracketPower(duelFighter(snapshot), bracket),
      powerVersion: BRACKET_POWER_VERSION,
    })
    .where(eq(duelDefences.id, defence.id));
  return removed;
}

/** The hero as it fights now: its equipped items, checked (5.1's rules). */
export async function heroDuelSnapshot(tx: Executor, hero: Character): Promise<DuelSnapshot> {
  const rows = await tx
    .select({
      slot: itemInstances.equippedSlot,
      seed: itemInstances.seed,
      baseId: itemInstances.baseId,
      rarityId: itemInstances.rarityId,
      itemLevel: itemInstances.itemLevel,
      affixes: itemInstances.affixes,
      upgradeLevel: itemInstances.upgradeLevel,
      variant: itemInstances.variant,
      awakening: itemInstances.awakening,
      effectId: itemInstances.effectId,
      effectRoll: itemInstances.effectRoll,
      mythicId: itemInstances.mythicId,
      setId: itemInstances.setId,
    })
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, hero.id), isNotNull(itemInstances.equippedSlot)))
    .orderBy(asc(itemInstances.equippedSlot));
  const equipment: ScoredItem[] = rows.map((r) => ({ ...r, slot: r.slot! }));
  return duelSnapshot({
    classId: hero.classId,
    level: hero.level,
    xp: hero.experience,
    name: hero.name,
    equipment,
  });
}

/** Rated duels the account fought on a duel day. */
export async function ratedDuelsOn(executor: Executor, accountId: string, day: string) {
  const [row] = await executor
    .select({ n: count() })
    .from(duels)
    .where(
      and(eq(duels.challengerAccountId, accountId), eq(duels.day, day), eq(duels.kind, 'rated')),
    );
  // Ticket D.4: an admin's daily reset on a test account forgives that day's duels so far.
  const [reset] = await executor
    .select({ day: accounts.duelResetDay, n: accounts.duelResetCount })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const forgiven = reset?.day === day ? reset.n : 0;
  return Math.max(0, (row?.n ?? 0) - forgiven);
}

/** Accounts among `ids` with an active sanction of any kind at `now`. */
export async function sanctionedAmong(
  executor: Executor,
  ids: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await queryRows<{ subject_id: string }>(
    executor,
    sql`select distinct s.subject_id from sanctions s
      where s.subject_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz`,
  );
  return new Set(rows.map((r) => r.subject_id));
}

/** One defence as matchmaking reads it. */
interface CandidateRow {
  id: string;
  accountId: string;
  characterId: string;
  level: number;
  snapshot: DuelSnapshot;
  power: number | null;
  powerVersion: number | null;
}

/** A defence's bracket Power: the stored value, or (set before 5.6, or an older Power) computed. */
export function defencePower(
  d: Pick<CandidateRow, 'snapshot' | 'power' | 'powerVersion'>,
  bracketId: string,
) {
  if (d.power !== null && d.powerVersion === BRACKET_POWER_VERSION) return d.power;
  // Ticket 6.5b: bracket Power 2 equals 1 for a snapshot without an awakening (every defence set
  // before 6.5b), so a stored version-1 value is still right for it.
  if (d.power !== null && d.powerVersion === 1 && !d.snapshot.equipment.some((i) => i.awakening)) {
    return d.power;
  }
  const bracket = findPvpBracket(bracketId) ?? pvpBracketOf(d.snapshot.level);
  return bracketPower(duelFighter(d.snapshot), bracket);
}

export interface OpponentDraw {
  defenceIds: string[];
  /** The Power range used (null: nobody in any range). */
  powerStep: number | null;
  widened: number;
}

/**
 * Draws a rated opponent list for a hero (ticket 5.6 matchmaking, docs/PVP.md "Matchmaking"):
 * defences in its bracket at level 10 or more, from other accounts, never blocked either way or
 * sanctioned, never a friend, guildmate or an account sharing a sign-up signal (repeat pairs are
 * never left out since B.4b: their duels count for ¼; matchmaking offers fresh pairs first); then
 * game-core `pickOpponents` by bracket Power range and rating, from a `crypto` seed, at most one
 * per account.
 */
export async function drawOpponents(
  executor: Executor,
  accountId: string,
  seeker: { characterId: string; snapshot: DuelSnapshot },
  bracketId: string,
  gameNow: Date,
  authNow: Date,
  seed: string,
): Promise<OpponentDraw> {
  const rows: CandidateRow[] = await executor
    .select({
      id: duelDefences.id,
      accountId: duelDefences.accountId,
      characterId: duelDefences.characterId,
      level: duelDefences.level,
      snapshot: duelDefences.snapshot,
      power: duelDefences.power,
      powerVersion: duelDefences.powerVersion,
    })
    .from(duelDefences)
    .where(
      and(
        eq(duelDefences.bracketId, bracketId),
        ne(duelDefences.accountId, accountId),
        sql`${duelDefences.level} >= ${RATED_DUEL_MIN_LEVEL}`,
        sql`not exists (select 1 from sanctions s where s.subject_id = ${duelDefences.accountId}
          and s.lifted_at is null and s.expires_at > ${authNow.toISOString()}::timestamptz)`,
        // Ticket D.4: test accounts are never offered to players, and see only each other.
        sql`(select ta.is_test from accounts ta where ta.id = ${duelDefences.accountId})
          = (select tb.is_test from accounts tb where tb.id = ${accountId})`,
      ),
    )
    .orderBy(sql`random()`)
    .limit(MATCH_CANDIDATES);
  const owners = [...new Set(rows.map((r) => r.accountId))];
  const [blocked, excluded, pairs] = await Promise.all([
    blockedEitherWay(executor, accountId, owners),
    ratedExclusions(executor, accountId, owners),
    pairCountsWith(executor, accountId, owners, gameNow),
  ]);
  const eligible = rows.filter((r) => !blocked.has(r.accountId) && !excluded.has(r.accountId));
  const season = await ratingSeasonAt(executor, gameNow);
  const ratings = await ratingsFor(executor, season?.number ?? null, [
    seeker.characterId,
    ...eligible.map((r) => r.characterId),
  ]);
  const bracket = findPvpBracket(bracketId) ?? pvpBracketOf(seeker.snapshot.level);
  const mine = ratings.get(seeker.characterId)!.rating;
  const result = pickOpponents(
    {
      rating: mine.rating,
      deviation: mine.deviation,
      power: bracketPower(duelFighter(seeker.snapshot), bracket),
      classId: seeker.snapshot.classId,
    },
    eligible.map((r) => {
      const rt = ratings.get(r.characterId)!.rating;
      return {
        defenceId: r.id,
        accountId: r.accountId,
        power: defencePower(r, bracketId),
        // Ticket B.4 (matchmaking 2): Power relative to the class; fresh pairs first.
        classId: r.snapshot.classId,
        recentDuels: pairs.get(r.accountId) ?? 0,
        rating: rt.rating,
        deviation: rt.deviation,
      };
    }),
    seed,
    DUEL_OFFER_SIZE,
  );
  return {
    defenceIds: result.picks.map((p) => p.candidate.defenceId),
    powerStep: result.powerStep,
    widened: result.widened,
  };
}

/** Defences matchmaking reads per draw (a random sample of the bracket when it is larger). */
export const MATCH_CANDIDATES = 500;

/** Another player as the arena shows them (the 5.2 board's privacy pattern). */
export interface ArenaPlayerView {
  handle: string;
  /** Null while a moderator hides the name. */
  displayName: string | null;
  /** Whether this viewer may open the profile (`canViewProfile`). */
  profile: boolean;
}

export interface ArenaHeroView {
  /** Shown only where the profile may be opened (and not hidden by a moderator). */
  name: string | null;
  classId: ClassId;
  level: number;
  /** Ticket 6.8: the hero's appearance (palette id), shown with the name; null = own colours. */
  palette: string | null;
}

interface PersonFacts {
  relation: ProfileRelation;
  handle: string;
  displayName: string | null;
  visibility: Parameters<typeof canViewProfile>[0];
}

/**
 * How `viewerId` sees other accounts and their heroes: display names (null while hidden), whether
 * the profile may be opened, and which hero names show (profile viewable, name not hidden).
 * Three or four queries whatever the list's length.
 */
export async function arenaPeople(
  executor: Executor,
  viewerId: string,
  accountIds: readonly string[],
  characterIds: readonly string[],
  now: Date,
) {
  const ids = [...new Set(accountIds)];
  const [rows, relations, raw, hidden, palettes] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : executor
          .select({
            id: accounts.id,
            handle: accounts.handle,
            displayName: accounts.displayName,
            visibility: accounts.profileVisibility,
          })
          .from(accounts)
          .where(inArray(accounts.id, ids)),
    profileRelationsFor(executor, viewerId, ids),
    relationsFor(executor, viewerId, ids),
    hiddenTargetKeys(
      executor,
      [
        ...ids.map((id) => profileFieldKey(id, 'displayName')),
        ...characterIds.map((id) => characterNameKey(id)),
      ],
      now,
    ),
    heroPalettes(executor, characterIds),
  ]);
  const facts = new Map<string, PersonFacts>();
  for (const r of rows) {
    facts.set(r.id, {
      relation: relations.get(r.id) ?? 'stranger',
      handle: r.handle,
      displayName:
        r.id !== viewerId && hidden.has(profileFieldKey(r.id, 'displayName'))
          ? null
          : r.displayName,
      visibility: r.visibility,
    });
  }
  return {
    /** Null for a deleted account or one blocked either way (never announced). */
    player(accountId: string | null): ArenaPlayerView | null {
      const f = accountId ? facts.get(accountId) : undefined;
      if (!f || f.relation === 'blocked') return null;
      return {
        handle: f.handle,
        displayName: f.displayName,
        profile: canViewProfile(f.visibility, f.relation),
      };
    },
    /**
     * Whether the viewer blocks this account (their own block, shown so they know why the name is
     * gone). Ticket 5.8: never true for a block the other side made, which is never announced.
     */
    blocked(accountId: string | null): boolean {
      return accountId ? raw.get(accountId) === 'blocked-by-me' : false;
    },
    hero(
      accountId: string | null,
      characterId: string | null,
      hero: { name: string; classId: ClassId; level: number },
    ): ArenaHeroView {
      const f = accountId ? facts.get(accountId) : undefined;
      const mine = accountId === viewerId;
      const visible =
        mine ||
        (f !== undefined &&
          canViewProfile(f.visibility, f.relation) &&
          !(characterId && hidden.has(characterNameKey(characterId))));
      return {
        name: visible ? hero.name : null,
        classId: hero.classId,
        level: hero.level,
        palette: visible && characterId ? (palettes.get(characterId) ?? null) : null,
      };
    },
  };
}
