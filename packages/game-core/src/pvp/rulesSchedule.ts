import {
  PVP_RULES_BASELINE,
  PVP_RULES_VERSION,
  SUPPORTED_PVP_RULES_VERSIONS,
} from './normalise.js';

/**
 * Ticket 9.2: duel rules versions between seasons (5.3's rule, like 6.1's formula switches in
 * `scoring/schedule.ts`). The first time a server sees a newer `PVP_RULES_VERSION` it plans one
 * switch; if a season is under way, the switch waits for **that season's end** (as the season plan
 * stands), between seasons it applies at once. Until then rated and friendly duels are fought under
 * the older version, so no duel of a running season's ladder reads loadouts. Pure.
 */
export interface PvpRulesSwitch {
  from: number;
  to: number;
  /** The season whose end the switch waits for; null: in force from when it was planned. */
  afterSeason: number | null;
  plannedAt: string;
}

type Seasons = readonly { number: number; startsAt: Date; endsAt: Date }[];

function inForce(s: PvpRulesSwitch, seasons: Seasons, now: Date): boolean {
  if (s.afterSeason === null) return true;
  const season = seasons.find((x) => x.number === s.afterSeason);
  return !season || now.getTime() >= season.endsAt.getTime();
}

/** The duel rules version in force at `now`. */
export function pvpRulesVersionAt(
  plan: readonly PvpRulesSwitch[],
  seasons: Seasons,
  now: Date,
): number {
  let v = PVP_RULES_BASELINE;
  for (const s of plan) if (s.from === v && inForce(s, seasons, now)) v = s.to;
  return v;
}

/** The version once every planned switch is in force. */
export function plannedPvpRulesVersion(plan: readonly PvpRulesSwitch[]): number {
  let v = PVP_RULES_BASELINE;
  for (const s of plan) if (s.from === v) v = s.to;
  return v;
}

/** The switch to add so the plan reaches `latest` (none when it already does). */
export function planPvpRulesSwitch(
  plan: readonly PvpRulesSwitch[],
  seasons: Seasons,
  now: Date,
  latest: number = PVP_RULES_VERSION,
): PvpRulesSwitch[] {
  const planned = plannedPvpRulesVersion(plan);
  if (planned === latest) return [];
  const t = now.getTime();
  const running = seasons.find((s) => s.startsAt.getTime() <= t && t < s.endsAt.getTime());
  return [
    {
      from: planned,
      to: latest,
      afterSeason: running?.number ?? null,
      plannedAt: now.toISOString(),
    },
  ];
}

/** A stored plan, checked: unknown versions or shapes are dropped (never trusted). */
export function normalisePvpRulesPlan(value: unknown): PvpRulesSwitch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): PvpRulesSwitch[] => {
    if (typeof v !== 'object' || v === null) return [];
    const s = v as Record<string, unknown>;
    const ok = (n: unknown) => typeof n === 'number' && SUPPORTED_PVP_RULES_VERSIONS.includes(n);
    if (!ok(s.from) || !ok(s.to)) return [];
    const after = s.afterSeason;
    if (after !== null && !(typeof after === 'number' && Number.isInteger(after) && after >= 1))
      return [];
    return [
      {
        from: s.from as number,
        to: s.to as number,
        afterSeason: after as number | null,
        plannedAt: typeof s.plannedAt === 'string' ? s.plannedAt : '',
      },
    ];
  });
}
