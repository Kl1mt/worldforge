import type { ClassId } from '../classes.js';
import type { Relation } from '../social/relations.js';
import { checkEquipment, type ItemRejection, type ScoredItem } from '../scoring/equipment.js';
import type { EquippedItem } from '../activity/equipment.js';
import { pvpBracketOf, type PvpConfig, DEFAULT_PVP_CONFIG } from './normalise.js';
import type { PvpFighterInput } from './normalise.js';

/**
 * The arena (ticket 5.5, docs/PVP.md "The arena"): defence snapshots, rated duels and friendly
 * challenges. Rules as data: the limits, the duel day, the permission matrix and the snapshot a
 * defence stores. The duel itself is `simulateDuel` (5.4); the rating, matchmaking and the
 * win-trading rules are 5.6 (`rating.ts`, `matchmaking.ts`, `integrity.ts`).
 */

/** Rated duels an account may fight per duel day (Phase 5 default). */
export const RATED_DUELS_PER_DAY = 10;
/** Owner decision (5.4): rated duels open at level 10; the 1–9 bracket has none. */
export const RATED_DUEL_MIN_LEVEL = 10;
/** Opponents the server offers at a time (each a different account). */
export const DUEL_OFFER_SIZE = 5;
/** A fresh opponent list can be asked for this long after the last one (fought ones drop out). */
export const DUEL_OFFER_REFRESH_MS = 5 * 60_000;

export const DUEL_KINDS = ['rated', 'friendly'] as const;
export type DuelKind = (typeof DUEL_KINDS)[number];

/**
 * The duel day: the UTC date of the game clock (`YYYY-MM-DD`), like the contract and merchant
 * days. Stored with each duel (the window rule: a duel counts on the day it committed).
 */
export function duelDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** When the next duel day begins (the next UTC midnight). */
export function nextDuelDayAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * A defence (or attack) snapshot: the hero as it fights, taken at a defined moment. Only items
 * that pass 5.1's checks (`checkEquipment`: valid by `validateItem`, a sane upgrade, a slot that
 * fits, usable by the class, one per slot) are stored; a rejected item counts 0 and is listed in
 * `rejected` (the reasons only, never the item).
 */
export interface DuelSnapshot {
  classId: ClassId;
  level: number;
  xp: number;
  heroName: string;
  equipment: ScoredItem[];
  rejected: ItemRejection[];
}

export function duelSnapshot(hero: {
  classId: ClassId;
  level: number;
  xp: number;
  name: string;
  equipment: readonly ScoredItem[];
}): DuelSnapshot {
  const checked = checkEquipment(hero.classId, hero.equipment);
  return {
    classId: hero.classId,
    level: hero.level,
    xp: hero.xp,
    heroName: hero.name,
    equipment: checked.filter((c) => c.rejection === null).map((c) => ({ ...c.item })),
    rejected: checked.flatMap((c) => (c.rejection ? [c.rejection] : [])),
  };
}

/**
 * A stored snapshot as `simulateDuel` reads it. The items are checked again (a stored row is
 * never trusted), so a forged item that slipped into a snapshot still counts 0.
 */
export function duelFighter(snapshot: DuelSnapshot): PvpFighterInput {
  const equipment: EquippedItem[] = checkEquipment(snapshot.classId, snapshot.equipment).flatMap(
    (c) => (c.equipped ? [c.equipped] : []),
  );
  return { classId: snapshot.classId, level: snapshot.level, equipment };
}

/** The bracket a rated duel is fought in: the challenger's (the defence must be in it too). */
export function ratedBracketId(level: number, config: PvpConfig = DEFAULT_PVP_CONFIG): string {
  return pvpBracketOf(level, config).id;
}

export interface DuelRefusal {
  status: number;
  code: string;
  message: string;
}

export const DUEL_REFUSALS = {
  self: {
    status: 422,
    code: 'cannot_target_self',
    message: 'You cannot duel your own heroes.',
  },
  // A block either way is answered like an unknown opponent: a block is never announced.
  notFound: { status: 404, code: 'not_found', message: 'No such opponent.' },
  notFriend: {
    status: 403,
    code: 'not_friend_or_guildmate',
    message: 'Friendly challenges are for friends and guildmates.',
  },
  levelTooLow: {
    status: 403,
    code: 'level_too_low',
    message: `Rated duels open at level ${RATED_DUEL_MIN_LEVEL}. Friendly challenges are open now.`,
  },
  wrongBracket: {
    status: 409,
    code: 'wrong_bracket',
    message: 'That defence is no longer in your bracket. Ask for a fresh list.',
  },
  // Ticket 5.6: friends and guildmates never meet in a rated duel (win-trading).
  friendlyOnly: {
    status: 409,
    code: 'friendly_only',
    message: 'Friends and guildmates meet in friendly challenges, not rated duels.',
  },
  // Ticket 5.6: a pair that shares a sign-up signal is answered like an opponent never offered.
  notOffered: {
    status: 404,
    code: 'not_offered',
    message: 'That opponent is not on your list. Ask for a fresh list.',
  },
  noDuelsLeft: {
    status: 409,
    code: 'no_duels_left',
    message: `You have fought your ${RATED_DUELS_PER_DAY} rated duels today. More at midnight (UTC).`,
  },
} as const satisfies Record<string, DuelRefusal>;

export type DuelDecision = 'allowed' | DuelRefusal;

export interface DuelFacts {
  /** The relation of the challenger to the defender's account (4.3's model). */
  relation: Relation;
  /** Both are in the same guild (read live). */
  guildmate: boolean;
  /** The defender's account has an active sanction of any kind. */
  defenderSanctioned: boolean;
  challengerLevel: number;
  /** The level stored in the defence snapshot. */
  defenderLevel: number;
  /** Rated duels the challenger's account fought this duel day. */
  ratedToday: number;
  /** Ticket 5.6: the two accounts share a sign-up signal (`integrity.ts`; never announced). */
  sharedSignal?: boolean;
}

/**
 * Who may challenge whom (ticket 5.5). Checked in this order; tested relation × kind in
 * `arena.test.ts` (game-core) and through the API in `duels.test.ts` against a hand-written table.
 *
 * | relation ↓ / kind → | rated | friendly |
 * |---|---|---|
 * | self (own account) | 422 cannot_target_self | 422 cannot_target_self |
 * | blocked-by-me, blocked-by-them | 404 not_found | 404 not_found |
 * | defender sanctioned (any kind) | 404 not_found | 404 not_found |
 * | stranger, requested-by-me, requested-by-them | ✓ | 403 not_friend_or_guildmate (✓ if guildmates) |
 * | friend, guildmate | 409 friendly_only (5.6) | ✓ |
 * | shared sign-up signal (5.6) | 404 not_offered | as the relation |
 *
 * Then, rated only: challenger below level 10 (`403 level_too_low`), the defence in another
 * bracket (`409 wrong_bracket`), friend or guildmate (`409 friendly_only`), a shared sign-up
 * signal (`404 not_offered`), 10 rated duels already fought today (`409 no_duels_left`).
 * Friendly challenges have no level minimum, cross brackets (`friendlyBracket`) and no daily limit.
 * The challenger's own sanctions are the social-write rules (suspended: no request at all; a mute
 * does not stop a duel: it carries no text).
 */
export function duelDecision(kind: DuelKind, f: DuelFacts): DuelDecision {
  if (f.relation === 'self') return DUEL_REFUSALS.self;
  // A block is never announced (ticket 5.8): a friendly challenge past one answers as to a
  // stranger, a rated one as for a defender gone (the server checks its list first).
  if (f.relation === 'blocked-by-me' || f.relation === 'blocked-by-them')
    return kind === 'friendly' ? DUEL_REFUSALS.notFriend : DUEL_REFUSALS.notFound;
  if (f.defenderSanctioned) return DUEL_REFUSALS.notFound;
  if (kind === 'friendly') {
    return f.relation === 'friend' || f.guildmate ? 'allowed' : DUEL_REFUSALS.notFriend;
  }
  if (f.challengerLevel < RATED_DUEL_MIN_LEVEL) return DUEL_REFUSALS.levelTooLow;
  if (ratedBracketId(f.challengerLevel) !== ratedBracketId(f.defenderLevel))
    return DUEL_REFUSALS.wrongBracket;
  if (f.relation === 'friend' || f.guildmate) return DUEL_REFUSALS.friendlyOnly;
  if (f.sharedSignal) return DUEL_REFUSALS.notOffered;
  if (f.ratedToday >= RATED_DUELS_PER_DAY) return DUEL_REFUSALS.noDuelsLeft;
  return 'allowed';
}

/** Whether a hero may fight rated duels at all (the arena screen's gate). */
export const ratedDuelsOpen = (level: number) => level >= RATED_DUEL_MIN_LEVEL;
