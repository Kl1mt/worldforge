import { GUILD_REFUSALS, type GuildRefusal, type GuildStanding } from '../social/guilds.js';
import { GUILD_BOSS_ATTEMPTS_PER_WEEK, type GuildBossDefinition } from './definitions.js';

/**
 * Who may do what with the guild boss (ticket 4.9, "permissions as data"; tested role × action
 * through the API in `guild-boss-permissions.test.ts`; the client draws its buttons from it).
 *
 * | action ↓ / standing → | leader | officer | member | not a member |
 * |---|---|---|---|---|
 * | view (the guild's boss, its board) | ✓ | ✓ | ✓ | 404 not_in_guild |
 * | attempt | ✓ | ✓ | ✓ | 404 not_in_guild |
 * | claim (one's own earned rewards) | ✓ | ✓ | ✓ | ✓ (rewards stay the player's after leaving) |
 *
 * A block changes none of these (fighting reaches no one); it only hides names on the board.
 * The state refusals come after the standing: no attempts left this week (`409
 * no_attempts_left`), a hero below the boss's level (`409 hero_too_low`), nothing to claim (`409
 * nothing_to_claim`).
 */
export const GUILD_BOSS_ACTIONS = ['view', 'attempt', 'claim'] as const;
export type GuildBossAction = (typeof GUILD_BOSS_ACTIONS)[number];

export type GuildBossDecision = 'allowed' | GuildRefusal;

export const GUILD_BOSS_REFUSALS = {
  noAttemptsLeft: {
    status: 409,
    code: 'no_attempts_left',
    message: `You have used your ${GUILD_BOSS_ATTEMPTS_PER_WEEK} attempts this week. The boss rises again on Monday (UTC).`,
  },
  heroTooLow: {
    status: 409,
    code: 'hero_too_low',
    message: 'This hero is not strong enough to face the boss yet.',
  },
  nothingToClaim: {
    status: 409,
    code: 'nothing_to_claim',
    message: 'There is no guild boss reward waiting for you.',
  },
} as const satisfies Record<string, GuildRefusal>;

const MEMBERS: readonly GuildStanding[] = ['leader', 'officer', 'member'];
const ALLOWED: Record<GuildBossAction, readonly GuildStanding[]> = {
  view: MEMBERS,
  attempt: MEMBERS,
  claim: [...MEMBERS, 'none'],
};

export interface GuildBossFacts {
  /** Attempts the account made this week (in any guild). */
  attemptsUsed?: number;
  /** Level of the hero sent in (attempt). */
  heroLevel?: number;
  /** Earned rewards not claimed yet (claim). */
  unclaimed?: number;
}

export function guildBossDecision(
  standing: GuildStanding,
  action: GuildBossAction,
  boss?: GuildBossDefinition,
  facts: GuildBossFacts = {},
): GuildBossDecision {
  if (!ALLOWED[action].includes(standing)) return GUILD_REFUSALS.notInGuild;
  if (action === 'attempt') {
    if ((facts.attemptsUsed ?? 0) >= GUILD_BOSS_ATTEMPTS_PER_WEEK)
      return GUILD_BOSS_REFUSALS.noAttemptsLeft;
    if (boss && facts.heroLevel !== undefined && facts.heroLevel < boss.minLevel)
      return GUILD_BOSS_REFUSALS.heroTooLow;
  }
  if (action === 'claim' && facts.unclaimed !== undefined && facts.unclaimed <= 0)
    return GUILD_BOSS_REFUSALS.nothingToClaim;
  return 'allowed';
}
