import { and, asc, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  DUEL_OFFER_SIZE,
  RATED_DUEL_MIN_LEVEL,
  canViewProfile,
  duelSnapshot,
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
import { blockedEitherWay } from '../social/relations.js';
import { profileRelationsFor } from '../social/profiles.js';
import { hiddenTargetKeys } from '../social/sanctions.js';
import { characterNameKey, profileFieldKey } from '../social/targets.js';

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
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)))
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
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)));
  if (!hero) throw new ApiError(404, 'not_found', 'No such character.');
  return hero;
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
  return row?.n ?? 0;
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

/**
 * Draws a rated opponent list for a hero: defences in its bracket at level 10 or more, from other
 * accounts, never blocked either way or sanctioned, at most one per account, in a random order.
 * (Matchmaking by rating and a power range is 5.6.)
 */
export async function drawOpponents(
  executor: Executor,
  accountId: string,
  bracketId: string,
  now: Date,
): Promise<string[]> {
  const blocked = await blockedEitherWay(executor, accountId);
  const rows = await executor
    .select({ id: duelDefences.id, accountId: duelDefences.accountId })
    .from(duelDefences)
    .where(
      and(
        eq(duelDefences.bracketId, bracketId),
        ne(duelDefences.accountId, accountId),
        sql`${duelDefences.level} >= ${RATED_DUEL_MIN_LEVEL}`,
        sql`not exists (select 1 from sanctions s where s.subject_id = ${duelDefences.accountId}
          and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(sql`random()`)
    .limit(200);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (blocked.has(r.accountId) || seen.has(r.accountId)) continue;
    seen.add(r.accountId);
    out.push(r.id);
    if (out.length >= DUEL_OFFER_SIZE) break;
  }
  return out;
}

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
  const [rows, relations, hidden] = await Promise.all([
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
    hiddenTargetKeys(
      executor,
      [
        ...ids.map((id) => profileFieldKey(id, 'displayName')),
        ...characterIds.map((id) => characterNameKey(id)),
      ],
      now,
    ),
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
    blocked(accountId: string | null): boolean {
      return accountId ? facts.get(accountId)?.relation === 'blocked' : false;
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
      return { name: visible ? hero.name : null, classId: hero.classId, level: hero.level };
    },
  };
}
