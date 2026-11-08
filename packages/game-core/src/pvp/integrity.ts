/**
 * Arena integrity (ticket 5.6, docs/PVP.md "Win-trading"): diminishing returns against the same
 * opponent, who may never meet in a rated duel, and the pattern report's flags. Rules as data.
 */

/** The window in which rated duels between the same two accounts count against each other. */
export const PAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The rating factor of a rated duel by how many rated duels the same two accounts (either one
 * challenging, any of their heroes) fought in the window before it: the first in full, then half,
 * then a quarter, and from the fourth on still a quarter (`PAIR_FACTOR_FLOOR`).
 *
 * Owner decision (ticket B.4b): repeat pairs never block. 5.6 counted the fourth duel for nothing
 * and stopped offering the pair, which in a small town emptied most opponent lists (B.4: 62 % of
 * a 20-player season's draws). Repeats still count for less, matchmaking still offers players not
 * met this week first (`freshPairsFirst`), and the moderators' pattern report still flags heavy
 * repeat pairs.
 */
export const PAIR_FACTORS: readonly number[] = [1, 0.5, 0.25];
/** The factor from the fourth rated duel of a pair within the window on (never 0). */
export const PAIR_FACTOR_FLOOR = 0.25;

export function ratingFactor(priorPairDuels: number): number {
  if (!Number.isInteger(priorPairDuels) || priorPairDuels < 0)
    throw new RangeError(`Prior duels are a whole number ≥ 0, not ${priorPairDuels}`);
  return PAIR_FACTORS[priorPairDuels] ?? PAIR_FACTOR_FLOOR;
}

/**
 * Accounts that never meet in a rated duel (friendly challenges stay open to friends and
 * guildmates): friends, guildmates, and accounts that share a sign-up signal the server already
 * stores (docs/PVP.md "Win-trading": the same mailbox, read from the stored email and compared
 * only on the server).
 */
export interface RatedPairFacts {
  friend: boolean;
  guildmate: boolean;
  sharedSignal: boolean;
}

export type RatedPairExclusion = 'friend' | 'guildmate' | 'sharedSignal' | null;

export function ratedPairExclusion(f: RatedPairFacts): RatedPairExclusion {
  if (f.friend) return 'friend';
  if (f.guildmate) return 'guildmate';
  if (f.sharedSignal) return 'sharedSignal';
  return null;
}

/**
 * The mailbox key of an email address: lower case, without a `+tag`, and for Gmail without dots
 * (`a.b+x@googlemail.com` and `ab@gmail.com` are one mailbox). Only ever compared on the server;
 * never stored, logged or sent anywhere.
 */
export function mailboxKey(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return email.trim().toLowerCase();
  let local = email.slice(0, at).trim().toLowerCase();
  let domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** The moderators' pattern report (docs/PVP.md "Pattern report"): thresholds as data. */
export const PATTERN_RULES = {
  /** Default window of the report. */
  windowDays: 14,
  /** A pair is listed from this many rated duels in the window. */
  minDuels: 3,
  /** "Repeated": at least this many rated duels in the window. */
  repeated: 5,
  /** "Lopsided": one side won at least this share of at least `lopsidedMin` duels. */
  lopsidedShare: 0.8,
  lopsidedMin: 4,
} as const;

export interface PairStats {
  duels: number;
  /** Wins of the account listed first, and of the second; draws are the rest. */
  winsA: number;
  winsB: number;
  /** Duels the first account started. */
  challengesA: number;
}

export type PatternFlag = 'repeated' | 'lopsided' | 'oneWay';

export function patternFlags(p: PairStats): PatternFlag[] {
  const flags: PatternFlag[] = [];
  if (p.duels >= PATTERN_RULES.repeated) flags.push('repeated');
  if (
    p.duels >= PATTERN_RULES.lopsidedMin &&
    Math.max(p.winsA, p.winsB) / p.duels >= PATTERN_RULES.lopsidedShare
  )
    flags.push('lopsided');
  if (p.duels >= PATTERN_RULES.minDuels && (p.challengesA === 0 || p.challengesA === p.duels))
    flags.push('oneWay');
  return flags;
}
