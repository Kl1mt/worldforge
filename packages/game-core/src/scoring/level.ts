import { MAX_LEVEL, xpToNextLevel } from '../combat/progression.js';
import { FORMULA_VERSIONS, type Score } from './types.js';

/**
 * Character Level (ticket 5.1, GDD §10.2): the level, then the experience within it as the
 * tie-breaker. Values the server would never store (a level outside 1…60, negative or
 * non-integer XP, XP at or above the level's requirement) are refused, not clamped.
 */
export function levelScore(level: number, experience: number): Score {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL)
    throw new RangeError(`Invalid level: ${level}`);
  const need = xpToNextLevel(level);
  if (
    !Number.isInteger(experience) ||
    experience < 0 ||
    (need > 0 && experience >= need) ||
    (need === 0 && experience !== 0)
  )
    throw new RangeError(`Invalid experience: ${experience}`);
  const pct = need > 0 ? Math.floor((experience / need) * 100) : 100;
  return {
    metric: 'level',
    formulaVersion: FORMULA_VERSIONS.level,
    value: level,
    sortKey: [level, experience],
    summary: 'Your level; between heroes of the same level, the experience earned toward the next.',
    lines: [
      { id: 'level', label: 'Level', detail: 'Ranks first', points: level, counted: true },
      {
        id: 'experience',
        label: 'Experience in this level',
        detail:
          need > 0
            ? `${experience.toLocaleString('en-US')} of ${need.toLocaleString('en-US')} (${pct} %): breaks ties`
            : 'Highest level reached',
        points: experience,
        counted: true,
      },
    ],
  };
}
