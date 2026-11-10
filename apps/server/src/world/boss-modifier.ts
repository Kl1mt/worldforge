import {
  bossModifierOfWeek,
  getBossModifier,
  guildBossWeek,
  type BossModifierId,
} from '@worldforge/game-core';

/**
 * Ticket 6.3: the weekly boss modifier as clients see it (docs/DUNGEONS.md "Weekly boss
 * modifiers"). Public: it is announced in the Tavern and shown at every boss door.
 */
export interface BossModifierView {
  id: BossModifierId;
  name: string;
  /** What it does, in plain words. */
  effect: string;
  /** The hoard's small loot focus while it holds. */
  lootFocus: { id: string; name: string; description: string };
}

export interface BossModifierWeekView {
  /** The week (Monday 00:00 UTC, start inclusive, end exclusive), as the guild boss's. */
  week: { key: string; startsAt: string; endsAt: string };
  modifier: BossModifierView;
}

export function bossModifierView(id: BossModifierId): BossModifierView {
  const m = getBossModifier(id);
  return {
    id: m.id,
    name: m.name,
    effect: m.effect,
    lootFocus: { id: m.lootFocus.id, name: m.lootFocus.name, description: m.lootFocus.description },
  };
}

/** The modifier of the week holding `ms` (one read of the game clock: the window rule). */
export function bossModifierWeekView(ms: number): BossModifierWeekView {
  const week = guildBossWeek(ms);
  return {
    week: {
      key: week.key,
      startsAt: new Date(week.startMs).toISOString(),
      endsAt: new Date(week.endMs).toISOString(),
    },
    modifier: bossModifierView(bossModifierOfWeek(week).id),
  };
}
