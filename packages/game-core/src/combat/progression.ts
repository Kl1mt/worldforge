/** Level cap for the current content. */
export const MAX_LEVEL = 60;

/**
 * Experience needed to advance from `level` to `level + 1`.
 * Grows quadratically (`700 · level²`, ticket B.1); 0 at the level cap. Never lower a level's
 * requirement below an earlier curve's (Phase 1: `80 · level^1.6`): stored XP must stay below it.
 */
export function xpToNextLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1) throw new RangeError(`Invalid level: ${level}`);
  if (level >= MAX_LEVEL) return 0;
  return 700 * level * level;
}

/** Total experience needed to reach `level` from level 1 with 0 XP. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToNextLevel(l);
  return total;
}

export interface LevelState {
  level: number;
  /** Experience toward the next level. Always 0 at the cap. */
  xp: number;
}

/**
 * Adds experience and applies any level-ups. XP beyond the cap is discarded.
 */
export function applyXp(state: LevelState, gained: number): LevelState {
  if (!Number.isFinite(gained) || gained < 0) throw new RangeError(`Invalid XP gain: ${gained}`);
  let { level, xp } = state;
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, xp: 0 };
  xp += gained;
  let need = xpToNextLevel(level);
  while (level < MAX_LEVEL && xp >= need) {
    xp -= need;
    level++;
    need = xpToNextLevel(level);
  }
  if (level >= MAX_LEVEL) xp = 0;
  return { level, xp };
}
