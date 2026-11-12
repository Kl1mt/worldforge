import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 8.5: the notification inbox (docs/NOTIFICATIONS.md). */
export type InboxKind =
  | 'drop'
  | 'trade.received'
  | 'trade.accepted'
  | 'trade.voided'
  | 'trade.released'
  | 'duel.defence'
  | 'event.reward'
  | 'season.honours'
  | 'guild.honours'
  | 'world.stage'
  | 'world.era'
  | 'release';

export interface InboxEntry {
  id: string;
  kind: InboxKind;
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export interface InboxSummary {
  unread: number;
  newest: string | null;
}

export interface InboxList {
  entries: InboxEntry[];
  unread: number;
}

/**
 * The summary and the list answer with an `ETag`; the browser revalidates with `If-None-Match`
 * and an unchanged answer costs the server a `304` (the cached body reaches us as before).
 */
export const inboxApi = {
  summary: (signal?: AbortSignal): Promise<ApiResult<InboxSummary>> =>
    apiRequest('/inbox/summary', signal ? { signal } : {}),
  list: (limit = 100, signal?: AbortSignal): Promise<ApiResult<InboxList>> =>
    apiRequest(`/inbox?limit=${limit}`, signal ? { signal } : {}),
  read: (
    which: { ids: string[] } | { all: true },
  ): Promise<ApiResult<{ marked: number; unread: number }>> =>
    apiRequest('/inbox/read', { method: 'POST', body: which }),
};
