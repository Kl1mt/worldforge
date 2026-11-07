import type { PrestigeTier, ScoreMetric } from '@worldforge/game-core';
import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 5.3: a season as the server shows it (`GET /api/seasons`, boards, the admin panel). */
export interface SeasonView {
  number: number;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'active' | 'closing' | 'closed';
  archivedAt: string | null;
  awardedAt: string | null;
}

export interface SeasonList {
  now: string;
  current: SeasonView | null;
  next: SeasonView | null;
  past: SeasonView[];
}

export interface PrestigeBadge {
  season: number;
  metric: ScoreMetric;
  tier: PrestigeTier;
}

/** What a player shows next to their name (cosmetic). */
export interface PrestigeShown {
  title: PrestigeBadge | null;
  frame: PrestigeBadge | null;
}

export const NO_PRESTIGE: PrestigeShown = { title: null, frame: null };

export interface EarnedAward extends PrestigeBadge {
  rank: number;
  heroName: string | null;
  awardedAt: string;
}

export interface PrestigeSettings {
  earned: EarnedAward[];
  shown: PrestigeShown;
}

export type PrestigeChoice = { season: number; metric: ScoreMetric } | null;

export const seasonsApi = {
  list: (signal?: AbortSignal): Promise<ApiResult<SeasonList>> =>
    apiRequest('/seasons', signal ? { signal } : {}),
  prestige: (signal?: AbortSignal): Promise<ApiResult<PrestigeSettings>> =>
    apiRequest('/account/prestige', signal ? { signal } : {}),
  savePrestige: (body: { title: PrestigeChoice; frame: PrestigeChoice }) =>
    apiRequest<PrestigeSettings>('/account/prestige', { method: 'POST', body }),
};

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "9 Nov 2026 – 4 Jan 2027" (UTC days; the end is exclusive, so the last day is shown). */
export function seasonSpan(s: Pick<SeasonView, 'startsAt' | 'endsAt'>): string {
  const lastMoment = new Date(Date.parse(s.endsAt) - 1);
  return `${DAY.format(new Date(s.startsAt))} – ${DAY.format(lastMoment)}`;
}

/** Whole days left until `endsAt` (at least 0). */
export function daysLeft(endsAt: string, now: string): number {
  return Math.max(0, Math.ceil((Date.parse(endsAt) - Date.parse(now)) / 86_400_000));
}
