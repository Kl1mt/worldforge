import { cryptTierCleared, type WorldProgress } from '../world/unlocks.js';

/**
 * Account growth (ticket 9.4, GDD §5.3 and §9.1, docs/ACCOUNTS.md): character slots and the
 * offline cap grow as the account plays. Data-driven: each grant is a rule with an id, a kind and
 * an unlock read from one hero's row (its level and world progress). The server grants a rule at
 * most once per account (`account_growth_grants`' primary key), records its source, audits it and
 * never removes it. Nothing here is sold: the offline cap never is (more offline hours are more
 * progress, which is power); a slot may later be bought in the shop (owner decision 2026-11-12,
 * ROADMAP 8.8) as a grant with source `shop`, which needs no new column.
 *
 * Never rename or reuse a rule id: granted rows keep it.
 */

/** Slots every account starts with (GDD §5.3). The server's `accounts.character_slots` default. */
export const BASE_CHARACTER_SLOTS = 2;

/**
 * Where a grant came from, as stored in `account_growth_grants.source`. Earned grants use their
 * rule id; `shop` is reserved for the later 8.8 shop (no rule grants it, nothing sells it yet).
 */
export type AccountGrantSource = AccountGrowthRuleId | 'shop';

export type AccountGrantKind = 'slot' | 'offline';

/** What a hero must do for a grant. Read from the hero's row after the change. */
export type AccountGrowthUnlock =
  | { kind: 'characterLevel'; level: number }
  /** The Nameless Crypt cleared at this tier or deeper (tier IV is the Heroic crypt). */
  | { kind: 'cryptTier'; tier: number }
  /** The Ashen Warden slain (opens the Cinderwastes). */
  | { kind: 'ashenWardenDefeated' }
  /**
   * A community project that is not built yet (the seam for the 5th slot: "the town's next
   * community project"). Never met: no hero row can reach it. When the project lands, its rule
   * changes to `{ kind: 'communityProject', projectId }` and the backfill grants it to every
   * contributor; the rule id `community` (the stored source) stays.
   */
  | { kind: 'futureCommunityProject' };

export interface AccountGrowthRule {
  id: string;
  kind: AccountGrantKind;
  unlock: AccountGrowthUnlock;
  /** What the player reads under "how to get it". */
  description: string;
}

export const ACCOUNT_GROWTH_RULES = [
  // Character slots (owner defaults, 2026-11-13).
  {
    id: 'level28',
    kind: 'slot',
    unlock: { kind: 'characterLevel', level: 28 },
    description: 'Raise any hero of the account to level 28.',
  },
  {
    id: 'heroicCrypt',
    kind: 'slot',
    unlock: { kind: 'cryptTier', tier: 4 },
    description: 'Clear the Heroic crypt (the Nameless Crypt, tier IV) with any hero.',
  },
  {
    id: 'community',
    kind: 'slot',
    unlock: { kind: 'futureCommunityProject' },
    description: 'Help build the town’s next great work. It has not been proclaimed yet.',
  },
  // Offline deeds: each one earned raises the cap one step (OFFLINE_BONUS_STEPS_MS).
  {
    id: 'offlineLevel10',
    kind: 'offline',
    unlock: { kind: 'characterLevel', level: 10 },
    description: 'Raise any hero to level 10.',
  },
  {
    id: 'offlineCrypt1',
    kind: 'offline',
    unlock: { kind: 'cryptTier', tier: 1 },
    description: 'Defeat the Gravewarden in the Nameless Crypt.',
  },
  {
    id: 'offlineCrypt3',
    kind: 'offline',
    unlock: { kind: 'cryptTier', tier: 3 },
    description: 'Clear the Nameless Crypt at tier III.',
  },
  {
    id: 'offlineCinderwastes',
    kind: 'offline',
    unlock: { kind: 'ashenWardenDefeated' },
    description: 'Slay the Ashen Warden and open the way to the Cinderwastes.',
  },
] as const satisfies readonly AccountGrowthRule[];

export type AccountGrowthRuleId = (typeof ACCOUNT_GROWTH_RULES)[number]['id'];

export const ACCOUNT_GROWTH_RULE_IDS: readonly AccountGrowthRuleId[] = ACCOUNT_GROWTH_RULES.map(
  (r) => r.id,
);

const BY_ID = new Map<string, AccountGrowthRule>(ACCOUNT_GROWTH_RULES.map((r) => [r.id, r]));

export function findAccountGrowthRule(id: string): AccountGrowthRule | undefined {
  return BY_ID.get(id);
}

export function isAccountGrowthRuleId(value: unknown): value is AccountGrowthRuleId {
  return typeof value === 'string' && BY_ID.has(value);
}

export const SLOT_RULES: readonly AccountGrowthRule[] = ACCOUNT_GROWTH_RULES.filter(
  (r) => r.kind === 'slot',
);
export const OFFLINE_RULES: readonly AccountGrowthRule[] = ACCOUNT_GROWTH_RULES.filter(
  (r) => r.kind === 'offline',
);

/** The hero fields an unlock reads (its row after the change). */
export interface GrowthHero {
  level: number;
  progress: Partial<WorldProgress>;
}

export function growthUnlockMet(unlock: AccountGrowthUnlock, hero: GrowthHero): boolean {
  switch (unlock.kind) {
    case 'characterLevel':
      return hero.level >= unlock.level;
    case 'cryptTier':
      return cryptTierCleared(hero.progress) >= unlock.tier;
    case 'ashenWardenDefeated':
      return hero.progress.ashenWardenDefeated === true;
    case 'futureCommunityProject':
      return false;
  }
}

/** The rule ids this hero's state earns for its account, in definition order. */
export function accountGrowthEarned(hero: GrowthHero): AccountGrowthRuleId[] {
  return ACCOUNT_GROWTH_RULES.filter((r) => growthUnlockMet(r.unlock, hero)).map((r) => r.id);
}

/**
 * The offline cap's bonus on top of the server's base (`OFFLINE_CAP_SECONDS`, 3 h by default),
 * by the number of offline deeds earned: 3 → 4 → 5 → 6 → 8 hours with the default base. Every
 * deed counts the same, so the order they are earned in does not matter.
 */
export const OFFLINE_BONUS_STEPS_MS: readonly number[] = [0, 1, 2, 3, 5].map((h) => h * 3_600_000);

/** The bonus for `deeds` earned offline deeds (clamped to the last step). */
export function offlineBonusMs(deeds: number): number {
  const i = Math.max(0, Math.min(Math.floor(deeds), OFFLINE_BONUS_STEPS_MS.length - 1));
  return OFFLINE_BONUS_STEPS_MS[i]!;
}

/** The cap in force once `deeds` offline deeds are earned. */
export function offlineCapMs(baseMs: number, deeds: number): number {
  return baseMs + offlineBonusMs(deeds);
}

/**
 * Where a hero's offline credit ends (ticket 9.4): the cap counts from the last client contact,
 * and each deed raises it **from the moment it is earned**. A deed earned while the cap still
 * runs (at or before the current end) extends it to the new step; a deed earned after the cap ran
 * out does not reopen it: time already lost is never paid back. Pure; `grantedAtMs` are the
 * account's offline grant times (any order).
 */
export function offlineCapEndMs(
  lastSeenMs: number,
  baseMs: number,
  grantedAtMs: readonly number[],
): number {
  const times = [...grantedAtMs].sort((a, b) => a - b);
  let deeds = 0;
  let endMs = lastSeenMs + offlineCapMs(baseMs, 0);
  for (const t of times) {
    // Earned before the contact (already in force) or while the cap still ran.
    if (t > endMs) break;
    deeds += 1;
    endMs = Math.max(endMs, lastSeenMs + offlineCapMs(baseMs, deeds));
  }
  return endMs;
}
