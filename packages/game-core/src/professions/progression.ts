import { PROFESSION_IDS, type ProfessionId } from '../world/materials.js';
import { DEFAULT_PROFESSION_CONFIG, type ProfessionConfig } from './config.js';

/** One profession's progress. `xp` is toward the next level (0 at the cap). */
export interface ProfessionState {
  level: number;
  xp: number;
}

export type ProfessionLevels = Record<ProfessionId, ProfessionState>;

/** Every profession at level 1 with 0 XP. */
export function initialProfessions(): ProfessionLevels {
  return Object.fromEntries(
    PROFESSION_IDS.map((id) => [id, { level: 1, xp: 0 }]),
  ) as ProfessionLevels;
}

/** XP needed to advance a profession from `level` to `level + 1`; 0 at the cap. */
export function professionXpToNext(
  level: number,
  config: ProfessionConfig = DEFAULT_PROFESSION_CONFIG,
): number {
  if (!Number.isInteger(level) || level < 1) throw new RangeError(`Invalid level: ${level}`);
  if (level >= config.maxLevel) return 0;
  return Math.round(config.xpBase * Math.pow(level, config.xpExponent));
}

/** Adds profession XP and applies level-ups. XP beyond the cap is discarded. */
export function applyProfessionXp(
  state: ProfessionState,
  gained: number,
  config: ProfessionConfig = DEFAULT_PROFESSION_CONFIG,
): ProfessionState {
  if (!Number.isFinite(gained) || gained < 0) throw new RangeError(`Invalid XP gain: ${gained}`);
  let { level, xp } = state;
  if (level >= config.maxLevel) return { level: config.maxLevel, xp: 0 };
  xp += gained;
  let need = professionXpToNext(level, config);
  while (level < config.maxLevel && xp >= need) {
    xp -= need;
    level++;
    need = professionXpToNext(level, config);
  }
  if (level >= config.maxLevel) xp = 0;
  return { level, xp };
}

/** Fills missing professions with level 1 and validates the rest. */
export function normalizeProfessions(
  partial: Partial<Record<ProfessionId, ProfessionState>> = {},
  config: ProfessionConfig = DEFAULT_PROFESSION_CONFIG,
): ProfessionLevels {
  const out = initialProfessions();
  for (const id of PROFESSION_IDS) {
    const s = partial[id];
    if (!s) continue;
    if (!Number.isInteger(s.level) || s.level < 1 || s.level > config.maxLevel) {
      throw new RangeError(`Invalid ${id} level: ${s.level}`);
    }
    if (!Number.isInteger(s.xp) || s.xp < 0) throw new RangeError(`Invalid ${id} xp: ${s.xp}`);
    out[id] = { level: s.level, xp: s.level >= config.maxLevel ? 0 : s.xp };
  }
  return out;
}
