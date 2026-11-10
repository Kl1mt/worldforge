import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 6.6: an event as the server shows it (`EventView`, docs/EVENTS.md). */
export interface EventCosmetic {
  id: string;
  kind: string;
  name: string;
  description: string;
  /** Titles can be shown today (the honours picker); the rest wait for the collection book. */
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
  quests: { id: string; name: string; description: string; target: number; tallies: number }[];
  track: { tier: number; tallies: number; cosmetic: EventCosmetic }[];
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'active' | 'closing' | 'closed' | 'cancelled';
}

export interface EventsNow {
  now: string;
  current: EventView | null;
  next: EventView | null;
}

export interface HeroEvent extends EventsNow {
  hero: {
    joinedAt: string;
    quests: { id: string; progress: number; target: number; done: boolean }[];
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
