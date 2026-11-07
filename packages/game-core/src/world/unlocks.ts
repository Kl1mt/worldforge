import type { WorldFlagId, WorldFlags } from './projects.js';

/**
 * Unlock rules for areas and dungeons (ticket 2.1). Pure; the server checks them before it
 * starts an activity (ticket 2.2). Never trust a client's claim that something is unlocked.
 */

/** What a place requires. All conditions must hold. */
export interface UnlockRule {
  /** Minimum character level. */
  level: number;
  /** The Gravewarden must have been defeated (ticket 2.5). */
  gravewardenDefeated?: boolean;
  /** Ticket 3.6: this Nameless Crypt tier must have been cleared (`cryptTierCleared`). */
  cryptTierCleared?: number;
  /**
   * Ticket 4.6: a global world flag (set by a completed community project) must be set. Read from
   * `UnlockCharacter.world`; without it the place stays closed (the safe default).
   */
  worldFlag?: WorldFlagId;
}

/** The character facts unlocks depend on. */
export interface UnlockCharacter {
  level: number;
  /**
   * Ticket 4.6: the global world flags (the server's world state). Only rules with a `worldFlag`
   * read them; callers that omit them see those places closed.
   */
  world?: WorldFlags;
}

/** Persistent world progress of a character (persisted by ticket 2.2). */
export interface WorldProgress {
  gravewardenDefeated: boolean;
  /**
   * Ticket 3.6: the deepest Nameless Crypt tier this character has cleared (boss killed). Absent
   * on characters from before 3.6: read it with `cryptTierCleared(progress)`, which counts a
   * Gravewarden kill as tier I.
   */
  cryptTierCleared?: number;
  /**
   * Ticket 4.8: the Ashen Warden (the Warden's Watch) has fallen to this character. Nothing is
   * gated on it yet; absent on characters that never fought it.
   */
  ashenWardenDefeated?: boolean;
}

/** The deepest crypt tier cleared (ticket 3.6); a pre-3.6 Gravewarden kill counts as tier I. */
export function cryptTierCleared(progress: Partial<WorldProgress>): number {
  const stored = Number.isInteger(progress.cryptTierCleared) ? progress.cryptTierCleared! : 0;
  return Math.max(stored, progress.gravewardenDefeated === true ? 1 : 0);
}

/** Why a place is locked, for the world map (ticket 2.2). */
export type UnlockBlocker =
  | { kind: 'level'; required: number }
  | { kind: 'gravewardenDefeated' }
  /** Ticket 3.6: clear this crypt tier first. */
  | { kind: 'cryptTier'; tier: number }
  /** Ticket 4.6: a community project must complete first (it sets this flag). */
  | { kind: 'worldFlag'; flag: WorldFlagId };

/** Unmet conditions of `rule`, in a stable order (level first). Empty means unlocked. */
export function unlockBlockers(
  rule: UnlockRule,
  character: UnlockCharacter,
  progress: WorldProgress,
): UnlockBlocker[] {
  if (!Number.isInteger(character.level) || character.level < 1) {
    throw new RangeError(`Invalid character level: ${character.level}`);
  }
  const blockers: UnlockBlocker[] = [];
  if (character.level < rule.level) blockers.push({ kind: 'level', required: rule.level });
  if (rule.gravewardenDefeated && progress.gravewardenDefeated !== true) {
    blockers.push({ kind: 'gravewardenDefeated' });
  }
  if (rule.cryptTierCleared !== undefined && cryptTierCleared(progress) < rule.cryptTierCleared) {
    blockers.push({ kind: 'cryptTier', tier: rule.cryptTierCleared });
  }
  if (rule.worldFlag !== undefined && character.world?.[rule.worldFlag] !== true) {
    blockers.push({ kind: 'worldFlag', flag: rule.worldFlag });
  }
  return blockers;
}

export function isUnlocked(
  rule: UnlockRule,
  character: UnlockCharacter,
  progress: WorldProgress,
): boolean {
  return unlockBlockers(rule, character, progress).length === 0;
}
