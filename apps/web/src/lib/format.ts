import { CORE_STATS, type CoreStatId, type StatDefinition } from '@worldforge/game-core';

const STAT_BY_ID = new Map<CoreStatId, StatDefinition>(CORE_STATS.map((s) => [s.id, s]));

export function statDefinition(id: CoreStatId): StatDefinition {
  const def = STAT_BY_ID.get(id);
  if (!def) throw new Error(`Unknown stat: ${id}`);
  return def;
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** A stat value for a stat sheet: `1,240`, `12.5%`, `1.40/s`. */
export function formatStatValue(id: CoreStatId, value: number): string {
  switch (statDefinition(id).format) {
    case 'flat':
      return integer.format(value);
    case 'percent':
      return `${percent.format(value)}%`;
    case 'perSecond':
      return `${decimal.format(value)}/s`;
  }
}

/** A signed modifier for an affix or comparison line: `+18`, `−3%`, `+0.10/s`. */
export function formatStatDelta(id: CoreStatId, value: number): string {
  const sign = value < 0 ? '−' : '+';
  return sign + formatStatValue(id, Math.abs(value));
}

export function formatNumber(value: number): string {
  return integer.format(value);
}
