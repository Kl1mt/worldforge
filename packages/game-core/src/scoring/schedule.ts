import { seasonAt, type SeasonWindow } from './seasons.js';
import {
  FORMULA_BASELINE,
  FORMULA_VERSIONS,
  SCORE_METRICS,
  SUPPORTED_FORMULA_VERSIONS,
  type FormulaVersions,
  type ScoreMetric,
} from './types.js';

/**
 * Formula versions between seasons (ticket 6.1, docs/LEADERBOARDS.md "Formula versions between
 * seasons"). A new formula version (`FORMULA_VERSIONS`) must not change a season board while the
 * season runs (5.3: "formula changes only between seasons"). So the server plans each switch once,
 * the first time it sees the new version: if a season is under way at that moment, the switch
 * waits for **that season's end** (as the season plan stands, so ending early or extending moves
 * it along); between seasons it applies at once. Until then the older version stays in force for
 * every write, read and check. Pure: the caller passes the stored plan, the seasons and `now`.
 */

/** One planned switch of a metric's formula. */
export interface FormulaSwitch {
  metric: ScoreMetric;
  from: number;
  to: number;
  /** The season whose end the switch waits for; null: in force from when it was planned. */
  afterSeason: number | null;
  /** ISO time the server planned it (audit). */
  plannedAt: string;
}

export type FormulaSchedule = readonly FormulaSwitch[];

type Seasons = readonly Pick<SeasonWindow, 'number' | 'startsAt' | 'endsAt'>[];

/** Whether a switch is in force at `now`. A season that no longer exists counts as ended. */
export function switchInForce(s: FormulaSwitch, seasons: Seasons, now: Date): boolean {
  if (s.afterSeason === null) return true;
  const season = seasons.find((x) => x.number === s.afterSeason);
  return !season || now.getTime() >= season.endsAt.getTime();
}

/** The formula version of each metric in force at `now`. */
export function formulaVersionsAt(
  schedule: FormulaSchedule,
  seasons: Seasons,
  now: Date,
): FormulaVersions {
  const out: Record<ScoreMetric, number> = { ...FORMULA_BASELINE };
  for (const s of schedule) {
    if (out[s.metric] === s.from && switchInForce(s, seasons, now)) out[s.metric] = s.to;
  }
  return out;
}

/** The version each metric will reach once every planned switch is in force. */
export function plannedFormulaVersions(schedule: FormulaSchedule): FormulaVersions {
  const out: Record<ScoreMetric, number> = { ...FORMULA_BASELINE };
  for (const s of schedule) if (out[s.metric] === s.from) out[s.metric] = s.to;
  return out;
}

/**
 * The switches to add so every metric reaches the newest version: one per metric whose planned
 * version is behind, waiting for the season under way at `now` (none: at once). Empty when the
 * plan is complete, so calling it again changes nothing.
 */
export function planFormulaSwitches(
  schedule: FormulaSchedule,
  seasons: Seasons,
  now: Date,
  latest: FormulaVersions = FORMULA_VERSIONS,
): FormulaSwitch[] {
  const planned = plannedFormulaVersions(schedule);
  const running = seasonAt(seasons as readonly SeasonWindow[], now);
  return SCORE_METRICS.filter((m) => planned[m] !== latest[m]).map((metric) => ({
    metric,
    from: planned[metric],
    to: latest[metric],
    afterSeason: running?.number ?? null,
    plannedAt: now.toISOString(),
  }));
}

/** A stored plan, checked: unknown metrics, versions or shapes are dropped (never trusted). */
export function normaliseFormulaSchedule(value: unknown): FormulaSwitch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): FormulaSwitch[] => {
    if (typeof v !== 'object' || v === null) return [];
    const s = v as Record<string, unknown>;
    const metric = s.metric as ScoreMetric;
    if (!SCORE_METRICS.includes(metric)) return [];
    const ok = (n: unknown) =>
      typeof n === 'number' && SUPPORTED_FORMULA_VERSIONS[metric].includes(n);
    if (!ok(s.from) || !ok(s.to)) return [];
    const after = s.afterSeason;
    if (after !== null && !(typeof after === 'number' && Number.isInteger(after) && after >= 1))
      return [];
    return [
      {
        metric,
        from: s.from as number,
        to: s.to as number,
        afterSeason: after as number | null,
        plannedAt: typeof s.plannedAt === 'string' ? s.plannedAt : '',
      },
    ];
  });
}
