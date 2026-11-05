import {
  CORE_STATS,
  SECONDARY_STATS,
  type ItemStatId,
  type StatDefinition,
} from '@worldforge/game-core';

type StatInfo = Pick<StatDefinition, 'name' | 'format'>;

/** Core stats and the secondary modifiers items can roll (gold find, item find, …), from game-core. */
const STAT_BY_ID = new Map<ItemStatId, StatInfo>([
  ...CORE_STATS.map((s): [ItemStatId, StatInfo] => [s.id, s]),
  ...SECONDARY_STATS.map((s): [ItemStatId, StatInfo] => [s.id, s]),
]);

export function statDefinition(id: ItemStatId): StatInfo {
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

/**
 * A stat value for a stat sheet: `1,240`, `12.5%`, `1.40/s`. Values are in game-core's
 * `StatBlock` units, where percent stats are fractions (`0.125` → `12.5%`, crit damage `1.5` → `150%`).
 */
export function formatStatValue(id: ItemStatId, value: number): string {
  switch (statDefinition(id).format) {
    case 'flat':
      return integer.format(value);
    case 'percent':
      return `${percent.format(value * 100)}%`;
    case 'perSecond':
      return `${decimal.format(value)}/s`;
  }
}

/** A signed modifier for an affix or comparison line: `+18`, `−3%`, `+0.10/s`. */
export function formatStatDelta(id: ItemStatId, value: number): string {
  const sign = value < 0 ? '−' : '+';
  return sign + formatStatValue(id, Math.abs(value));
}

export function formatNumber(value: number): string {
  return integer.format(value);
}

/** A duration for summaries: `45 s`, `12 min`, `2 h 05 min`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Time of day for log lines: `14:32:07` (local time). */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : clock.format(d);
}
