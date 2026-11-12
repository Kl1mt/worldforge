import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 6.6: an event as the server shows it (`EventView`, docs/EVENTS.md). */
export interface EventCosmetic {
  id: string;
  kind: string;
  name: string;
  description: string;
  /** Since 6.8 every catalogued cosmetic can be shown (the collection book). */
  shownToday: boolean;
}

export interface EventView {
  number: number;
  definitionId: string;
  name: string;
  tagline: string;
  giver: string;
  description: string;
  tallyName: string;
  modifier: { name: string; description: string };
  quests: {
    id: string;
    name: string;
    description: string;
    target: number;
    tallies: number;
    /** Ticket 8.3: the week it opens in (1 from the start), its level (null: every hero). */
    week: number;
    minLevel: number | null;
    opensAt: string;
  }[];
  track: { tier: number; tallies: number; cosmetic: EventCosmetic }[];
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'active' | 'closing' | 'closed' | 'cancelled';
  /** Ticket 8.3: weeks of the quest line; the week under way (0 before the start). */
  weeks: number;
  week: number;
  /** Ticket 8.3: `manual` or `calendar`. */
  source: string;
}

export interface EventsNow {
  now: string;
  current: EventView | null;
  next: EventView | null;
}

export interface HeroEvent extends EventsNow {
  hero: {
    joinedAt: string;
    /** `open`: its week has begun and the hero has its level (8.3). */
    quests: { id: string; progress: number; target: number; done: boolean; open: boolean }[];
    tallies: number;
    bountyKills: number;
    bonus: Record<string, number>;
  } | null;
  track: {
    tallies: number;
    granted: { tier: number; cosmeticId: string; grantedAt: string }[];
  } | null;
}

export interface CosmeticUnlock extends EventCosmetic {
  source: string;
  grantedAt: string;
}

export const eventsApi = {
  now: (signal?: AbortSignal): Promise<ApiResult<EventsNow>> =>
    apiRequest('/events', signal ? { signal } : {}),
  hero: (characterId: string, signal?: AbortSignal): Promise<ApiResult<HeroEvent>> =>
    apiRequest(`/characters/${characterId}/event`, signal ? { signal } : {}),
  join: (characterId: string): Promise<ApiResult<HeroEvent>> =>
    apiRequest(`/characters/${characterId}/event/join`, { method: 'POST' }),
  cosmetics: (signal?: AbortSignal): Promise<ApiResult<{ unlocks: CosmeticUnlock[] }>> =>
    apiRequest('/account/cosmetics', signal ? { signal } : {}),
};
