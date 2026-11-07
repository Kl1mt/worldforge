import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GUILD_CHAT_LIMITS,
  type GuildMessageKind,
  type GuildRole,
  type GuildTombstone,
} from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import { describeSocialFailure, type Sanction } from './api';

/** Ticket 4.5: one line of guild chat (or a notice) as the server sends it. */
export interface ChatLine {
  id: string;
  seq: number;
  kind: GuildMessageKind;
  author: { handle: string; displayName: string | null; role: GuildRole | null } | null;
  mine: boolean;
  /** Null for a tombstone: the text of a removed or hidden line never reaches the client. */
  text: string | null;
  tombstone: GuildTombstone | null;
  sentAt: string;
}

export interface ChatPage {
  guild: { handle: string };
  role: GuildRole;
  messages: ChatLine[];
  revised: ChatLine[];
  gone: number[];
  notice: ChatLine | null;
  next: number;
  hasOlder: boolean;
  more: boolean;
  mute: Sanction | null;
}

export const chatApi = {
  read: (
    query: { since?: number; before?: number; from?: number } = {},
    signal?: AbortSignal,
  ): Promise<ApiResult<ChatPage>> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return apiRequest(`/guild/chat${s ? `?${s}` : ''}`, signal ? { signal } : {});
  },
  post: (text: string): Promise<ApiResult<{ message: ChatLine }>> =>
    apiRequest('/guild/chat', { method: 'POST', body: { text } }),
  remove: (id: string): Promise<ApiResult<{ ok: boolean; tombstone: GuildTombstone }>> =>
    apiRequest(`/guild/chat/${encodeURIComponent(id)}/remove`, { method: 'POST' }),
  setNotice: (text: string): Promise<ApiResult<{ notice: ChatLine | null }>> =>
    apiRequest('/guild/notice', { method: 'POST', body: { text } }),
};

export function describeChatFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'not_in_guild':
      return 'You are no longer in this guild.';
    case 'message_not_found':
      return 'That line is gone from the chat.';
    case 'message_removed':
      return 'That line was struck already.';
    case 'guild_forbidden':
      return 'Your rank does not allow that.';
    case 'validation_failed':
      return Object.values(error.fields)[0] ?? 'That cannot be posted.';
    case 'rate_limited': {
      const s = error.retryAfterSeconds ?? 60;
      return `You are speaking too fast. Wait ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`}.`;
    }
    default:
      return describeSocialFailure(error);
  }
}

export type ChatState =
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiFailure }
  /** Not (or no longer) in the guild: the chat is closed at once and nothing stays on screen. */
  | { kind: 'closed' }
  | {
      kind: 'ready';
      lines: ChatLine[];
      notice: ChatLine | null;
      role: GuildRole;
      mute: Sanction | null;
      hasOlder: boolean;
      stale: boolean;
    };

/** Keeps at most this many lines on screen (older ones are loaded again on demand). */
const KEEP = GUILD_CHAT_LIMITS.historyMessages;

function bySeq(lines: Iterable<ChatLine>): ChatLine[] {
  return [...lines].sort((a, b) => a.seq - b.seq);
}

/**
 * The guild chat, polled while mounted: the newest page first, then `since` polls every 5 s while
 * the tab is visible (30 s while hidden) with the oldest held line as `from`, so removals and
 * blocks below the cursor arrive too. A poll after a long absence (`more`) reloads the newest
 * page. `404 not_in_guild` (left, kicked, disbanded) closes the chat at once.
 */
export function useGuildChat(onClosed?: () => void) {
  const [state, setState] = useState<ChatState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const lines = useRef(new Map<number, ChatLine>());
  const cursor = useRef<number | null>(null);
  const meta = useRef<Omit<
    Extract<ChatState, { kind: 'ready' }>,
    'kind' | 'lines' | 'stale'
  > | null>(null);
  const poke = useRef<() => void>(() => undefined);
  const closedRef = useRef(onClosed);
  useEffect(() => {
    closedRef.current = onClosed;
  }, [onClosed]);

  const publish = useCallback((stale = false) => {
    if (!meta.current) return;
    setState({ kind: 'ready', lines: bySeq(lines.current.values()), stale, ...meta.current });
  }, []);

  const apply = useCallback((page: ChatPage, mode: 'reset' | 'poll' | 'older') => {
    if (mode === 'reset') lines.current = new Map();
    for (const l of page.messages) lines.current.set(l.seq, l);
    for (const l of page.revised) lines.current.set(l.seq, l);
    for (const s of page.gone) lines.current.delete(s);
    if (lines.current.size > KEEP) {
      for (const s of bySeq(lines.current.values())
        .slice(0, lines.current.size - KEEP)
        .map((l) => l.seq)) {
        lines.current.delete(s);
      }
    }
    if (mode !== 'older') cursor.current = page.next;
    meta.current = {
      notice: page.notice,
      role: page.role,
      mute: page.mute,
      hasOlder: mode === 'poll' ? (meta.current?.hasOlder ?? false) : page.hasOlder,
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    lines.current = new Map();
    cursor.current = null;
    meta.current = null;

    const schedule = () => {
      if (stopped) return;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      timer = setTimeout(
        tick,
        hidden ? GUILD_CHAT_LIMITS.pollHiddenMs : GUILD_CHAT_LIMITS.pollVisibleMs,
      );
    };
    const tick = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const first = cursor.current === null;
      const oldest = bySeq(lines.current.values())[0]?.seq;
      const query = first
        ? {}
        : { since: cursor.current!, ...(oldest !== undefined ? { from: oldest } : {}) };
      chatApi.read(query, controller.signal).then(
        (res) => {
          if (stopped) return;
          if (res.ok) {
            if (res.value.more) {
              cursor.current = null;
              tick();
              return;
            }
            apply(res.value, first ? 'reset' : 'poll');
            publish();
          } else if (res.error.code === 'not_in_guild') {
            lines.current = new Map();
            meta.current = null;
            setState({ kind: 'closed' });
            closedRef.current?.();
            return;
          } else if (meta.current) {
            publish(true);
          } else {
            setState({ kind: 'error', error: res.error });
            return;
          }
          schedule();
        },
        () => {
          /* aborted */
        },
      );
    };
    poke.current = tick;
    tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [attempt, apply, publish]);

  /** Polls now (after a post or a removal). */
  const refresh = useCallback(() => poke.current(), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  /** Loads the page before the oldest line held. */
  const loadOlder = useCallback(async (): Promise<ApiResult<unknown>> => {
    const oldest = bySeq(lines.current.values())[0]?.seq;
    const res = await chatApi.read(oldest !== undefined ? { before: oldest } : {});
    if (res.ok) {
      apply(res.value, 'older');
      publish();
    }
    return res;
  }, [apply, publish]);

  return { state, refresh, retry, loadOlder };
}
