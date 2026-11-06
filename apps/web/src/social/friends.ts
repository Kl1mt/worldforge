import { useCallback, useEffect, useRef, useState } from 'react';
import type { PresenceBucket, Relation } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import { describeSocialFailure, sanctionOf, describeSanction } from './api';

/** A player in the friends lists (ticket 4.3). `displayName` is null while a moderator hides it. */
export interface FriendEntry {
  handle: string;
  displayName: string | null;
  /** Friends only; `null` when the friend hides it. A bucket, never a time. */
  presence?: PresenceBucket | null;
}

export interface FriendsView {
  friends: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
  blocked: FriendEntry[];
  presenceHidden: boolean;
  limits: { friends: number; outgoingRequests: number; incomingRequests: number; blocks: number };
}

type RelationResult = Promise<ApiResult<{ relation: Relation }>>;
const post = (path: string, body?: object): RelationResult =>
  apiRequest(path, { method: 'POST', ...(body ? { body } : {}) });
const h = encodeURIComponent;

export const friendsApi = {
  list: (signal?: AbortSignal): Promise<ApiResult<FriendsView>> =>
    apiRequest('/friends', signal ? { signal } : {}),
  requestByName: (name: string) => post('/friends/requests', { name }),
  request: (handle: string) => post('/friends/requests', { handle }),
  accept: (handle: string) => post(`/friends/requests/${h(handle)}/accept`),
  decline: (handle: string) => post(`/friends/requests/${h(handle)}/decline`),
  cancel: (handle: string) => post(`/friends/requests/${h(handle)}/cancel`),
  remove: (handle: string) => post(`/friends/${h(handle)}/remove`),
  block: (handle: string) => post('/blocks', { handle }),
  unblock: (handle: string) => post(`/blocks/${h(handle)}/remove`),
  relation: (handle: string): RelationResult => apiRequest(`/players/${h(handle)}/relation`),
  setPresenceHidden: (hidden: boolean): Promise<ApiResult<{ hidden: boolean }>> =>
    apiRequest('/account/presence', { method: 'POST', body: { hidden } }),
};

/** Plain words for a friends failure. */
export function describeFriendFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'not_found':
      return 'No player goes by that name.';
    case 'cannot_target_self':
      return 'That is you.';
    case 'request_pending':
      return 'Your request is already on its way. Wait for an answer.';
    case 'already_friends':
      return 'You are already companions.';
    case 'blocked_by_you':
      return 'You block this player. Unblock them first.';
    case 'already_blocked':
      return 'You already block this player.';
    case 'no_request':
      return 'That request is gone; it may have been withdrawn.';
    case 'not_friends':
      return 'You are no longer companions.';
    case 'not_blocked':
      return 'You do not block this player.';
    case 'friend_limit':
    case 'friend_limit_them':
    case 'request_limit':
    case 'inbox_full':
    case 'block_limit':
      return error.message;
    case 'muted': {
      const s = sanctionOf(error);
      return s ? describeSanction(s) : error.message;
    }
    case 'rate_limited': {
      const s = error.retryAfterSeconds ?? 60;
      return `Too many social actions in a short time. Try again in ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`}.`;
    }
    default:
      return describeSocialFailure(error);
  }
}

export type FriendsState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: FriendsView; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/**
 * The friends lists, polled while mounted (the browser revalidates with the server's ETag, so an
 * unchanged list costs a `304`). A failed poll keeps the last list and marks it stale.
 */
export function useFriends(pollMs = 60_000) {
  const [state, setState] = useState<FriendsState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const last = useRef<FriendsView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      friendsApi.list(controller.signal).then(
        (res) => {
          if (res.ok) {
            last.current = res.value;
            setState({ kind: 'ready', view: res.value, stale: false });
          } else if (last.current) {
            setState({ kind: 'ready', view: last.current, stale: true });
          } else {
            setState({ kind: 'error', error: res.error });
          }
          if (pollMs > 0) timer = setTimeout(load, pollMs);
        },
        () => {
          /* aborted */
        },
      );
    };
    load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt, pollMs]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
