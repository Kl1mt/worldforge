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
}

/** The character facts unlocks depend on. */
export interface UnlockCharacter {
  level: number;
}

/** Persistent world progress of a character (persisted by ticket 2.2). */
export interface WorldProgress {
  gravewardenDefeated: boolean;
}

/** Why a place is locked, for the world map (ticket 2.2). */
export type UnlockBlocker = { kind: 'level'; required: number } | { kind: 'gravewardenDefeated' };

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
  return blockers;
}

export function isUnlocked(
  rule: UnlockRule,
  character: UnlockCharacter,
  progress: WorldProgress,
): boolean {
  return unlockBlockers(rule, character, progress).length === 0;
}
