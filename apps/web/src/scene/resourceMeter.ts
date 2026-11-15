import type { ResourceId } from '@worldforge/game-core';

/**
 * Ticket A.18: how a class resource is drawn and how a change of it reads. Pure (no DOM), so the
 * rules are tested in node; `ResourceMeter` draws them.
 *
 * - Rage, Mana and Focus are a bar in ten notches (0–100).
 * - Soul Fragments are pips, one per fragment (3, or 5 with Soul Siphon).
 */
export type ResourceLook = 'bar' | 'pips';

export const RESOURCE_LOOK: Readonly<Record<ResourceId, ResourceLook>> = {
  rage: 'bar',
  mana: 'bar',
  focus: 'bar',
  soulFragments: 'pips',
};

/** A move of the resource: it filled (`gain`) or was spent (`spend`). */
export interface ResourceChange {
  kind: 'gain' | 'spend';
  /** The value before and after, clamped to [0, max]. */
  from: number;
  to: number;
}

export function clampResource(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.min(max, Math.max(0, value));
}

/** The change from `prev` to `next`, or null when the shown value didn't move. */
export function resourceChange(prev: number, next: number, max: number): ResourceChange | null {
  const from = clampResource(prev, max);
  const to = clampResource(next, max);
  if (from === to) return null;
  return { kind: to > from ? 'gain' : 'spend', from, to };
}

/**
 * The bar's flash for a change, as shares of the bar in percent: the slice between the old and
 * the new value (the Rage just gained, the Mana just spent). Whole tenths of a percent, so equal
 * values always draw the same.
 */
export function changeSlice(change: ResourceChange, max: number): { left: number; width: number } {
  const pct = (v: number) => Math.round((v / max) * 1000) / 10;
  const lo = Math.min(change.from, change.to);
  const hi = Math.max(change.from, change.to);
  return { left: pct(lo), width: Math.round((pct(hi) - pct(lo)) * 10) / 10 };
}

/**
 * Pips: for each pip, whether it is filled and whether it just moved (`gained` lit up, `spent`
 * went out). Fractions never happen for fragments; a value is floored.
 */
export function pipStates(
  current: number,
  max: number,
  change: ResourceChange | null,
): { filled: boolean; moved: 'gained' | 'spent' | null }[] {
  const n = Math.max(0, Math.floor(max));
  const value = Math.floor(clampResource(current, n));
  const lo = change ? Math.floor(Math.min(change.from, change.to)) : 0;
  const hi = change ? Math.floor(Math.max(change.from, change.to)) : 0;
  return Array.from({ length: n }, (_, i) => {
    const moved =
      change && i >= lo && i < hi ? (change.kind === 'gain' ? 'gained' : 'spent') : null;
    return { filled: i < value, moved };
  });
}

/** "Rage 62 / 100", "Soul Fragments 2 / 3". */
export function resourceText(name: string, current: number, max: number): string {
  return `${name} ${Math.floor(clampResource(current, max))} / ${max}`;
}
