import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClassId, ScoreMetric } from '@worldforge/game-core';
import { apiRequest, type ApiFailure } from '../lib/api';
import type { PrestigeShown, SeasonView } from './seasons';

/** One board entry (ticket 5.2, `GET /api/leaderboards/:metric`). */
export interface BoardEntry {
  rank: number;
  you: boolean;
  player: {
    handle: string;
    displayName: string | null;
    profile: boolean;
    /** Ticket 5.3: the title and frame the player shows. */
    prestige: PrestigeShown;
  };
  hero: { name: string | null; classId: ClassId; level: number };
  value: number;
  sortKey: number[];
  achievedOn: string;
}

export interface BoardView {
  metric: ScoreMetric;
  scope: 'allTime' | 'season';
  /** Ticket 5.3: the season shown; null for all time or before any season. */
  season: SeasonView | null;
  formulaVersion: number;
  filters: { classId: ClassId | null; bracket: string | null };
  total: number;
  entries: BoardEntry[];
  nextCursor: string | null;
  yours: BoardEntry[];
  youExcluded: boolean;
}

export interface BoardQuery {
  metric: ScoreMetric;
  classId: ClassId | null;
  bracket: string | null;
  /** Ticket 5.3: null = all time; `current` = the season under way (or the latest). */
  season: 'current' | number | null;
  cursor: string | null;
}

export const BOARD_PAGE_SIZE = 25;

export function boardPath(q: BoardQuery): string {
  const p = new URLSearchParams({ limit: String(BOARD_PAGE_SIZE) });
  if (q.classId) p.set('class', q.classId);
  if (q.bracket) p.set('bracket', q.bracket);
  if (q.season) p.set('scope', 'season');
  if (typeof q.season === 'number') p.set('season', String(q.season));
  if (q.cursor) p.set('cursor', q.cursor);
  return `/leaderboards/${q.metric}?${p.toString()}`;
}

export type BoardState =
  | { kind: 'loading' }
  | { kind: 'ready'; board: BoardView; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/**
 * One board page, polled every minute while open (the browser revalidates with the server's
 * ETag, so an unchanged board costs a `304`; one poll a minute is far inside the board read
 * limit of 60 a minute). A failed poll keeps the last page and marks it stale.
 */
export function useBoard(q: BoardQuery, pollMs = 60_000) {
  const [state, setState] = useState<BoardState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const path = boardPath(q);
  const last = useRef<{ path: string; board: BoardView } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (last.current?.path !== path) setState({ kind: 'loading' });
    const load = () => {
      apiRequest<{ board: BoardView }>(path, { signal: controller.signal }).then(
        (res) => {
          if (res.ok) {
            last.current = { path, board: res.value.board };
            setState({ kind: 'ready', board: res.value.board, stale: false });
          } else if (last.current?.path === path) {
            setState({ kind: 'ready', board: last.current.board, stale: true });
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
  }, [path, pollMs, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
