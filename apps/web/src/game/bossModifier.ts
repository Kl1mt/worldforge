import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 6.3: the weekly boss modifier (server `BossModifierView`, docs/DUNGEONS.md). */
export interface BossModifierInfo {
  id: string;
  name: string;
  /** What it does, in plain words. */
  effect: string;
  /** The hoard's small loot focus while it holds. */
  lootFocus: { id: string; name: string; description: string };
}

export interface BossModifierWeek {
  week: { key: string; startsAt: string; endsAt: string };
  modifier: BossModifierInfo;
}

export interface BossModifierResponse extends BossModifierWeek {
  now: string;
}

export const bossModifierApi = {
  /** This week's modifier (the Tavern's notice). */
  current: (): Promise<ApiResult<BossModifierResponse>> =>
    apiRequest<BossModifierResponse>('/world/boss-modifier'),
};

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** "until Monday 16 November" (the week's end is the next Monday 00:00 UTC; local date). */
export function modifierUntil(week: BossModifierWeek['week']): string {
  return `until ${dayFormat.format(new Date(week.endsAt))}`;
}
