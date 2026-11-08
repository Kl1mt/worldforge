import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClassId } from '@worldforge/game-core';
import { apiRequest, type ApiFailure } from '../lib/api';
import { formatNumber } from '../lib/format';
import type { PrestigeShown, SeasonView } from './seasons';

/**
 * Ticket 5.6: the arena ladder (`GET /api/arena/ladder`, docs/PVP.md "The ladder") and the words
 * a rating is shown in. A rating is per hero and per season; its range is ± 2 deviations.
 */

export type RatingStanding = 'provisional' | 'settling' | 'settled';

/** A rating as the server shows it (rounded, with its likely range and record). */
export interface RatingView {
  rating: number;
  low: number;
  high: number;
  standing: RatingStanding;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface LadderEntry {
  /** Null for your own provisional heroes (not ranked yet). */
  rank: number | null;
  you: boolean;
  player: { handle: string; displayName: string | null; profile: boolean; prestige: PrestigeShown };
  hero: { name: string | null; classId: ClassId; level: number };
  rating: RatingView;
}

export interface LadderView {
  season: SeasonView | null;
  filters: { classId: ClassId | null; bracket: string | null };
  provisionalGames: number;
  total: number;
  entries: LadderEntry[];
  nextCursor: string | null;
  yours: LadderEntry[];
  youExcluded: boolean;
}

export interface LadderQuery {
  classId: ClassId | null;
  bracket: string | null;
  /** `current` (or null) = the season under way, else the latest begun; a number = that season. */
  season: 'current' | number | null;
  cursor: string | null;
}

export const LADDER_PAGE_SIZE = 25;
/** The rated brackets (rated duels open at level 10: 1–9 has no ladder). */
export const LADDER_BRACKET_IDS = ['10-19', '20-29', '30-plus'] as const;

export function ladderPath(q: LadderQuery): string {
  const p = new URLSearchParams({ limit: String(LADDER_PAGE_SIZE) });
  if (q.classId) p.set('class', q.classId);
  if (q.bracket && (LADDER_BRACKET_IDS as readonly string[]).includes(q.bracket))
    p.set('bracket', q.bracket);
  if (typeof q.season === 'number') p.set('season', String(q.season));
  if (q.cursor) p.set('cursor', q.cursor);
  return `/arena/ladder?${p.toString()}`;
}

export type LadderState =
  | { kind: 'loading' }
  | { kind: 'ready'; ladder: LadderView; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/** The ladder page, polled once a minute with the ETag (like the boards); stale on a failed poll. */
export function useLadder(q: LadderQuery, pollMs = 60_000) {
  const [state, setState] = useState<LadderState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const path = ladderPath(q);
  const last = useRef<{ path: string; ladder: LadderView } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (last.current?.path !== path) setState({ kind: 'loading' });
    const load = () => {
      apiRequest<{ ladder: LadderView }>(path, { signal: controller.signal }).then(
        (res) => {
          if (res.ok) {
            last.current = { path, ladder: res.value.ladder };
            setState({ kind: 'ready', ladder: res.value.ladder, stale: false });
          } else if (last.current?.path === path) {
            setState({ kind: 'ready', ladder: last.current.ladder, stale: true });
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

/** "provisional — 7 more rated duels to be ranked" / "still settling" / "settled". */
export function standingWords(r: Pick<RatingView, 'standing' | 'games'>, provisionalGames: number) {
  if (r.standing === 'provisional') {
    const left = Math.max(1, provisionalGames - r.games);
    return `provisional — ${left} more rated ${left === 1 ? 'duel' : 'duels'} to be ranked`;
  }
  return r.standing === 'settling' ? 'still settling' : 'settled';
}

/** "likely 1,380–1,660". */
export const rangeWords = (r: Pick<RatingView, 'low' | 'high'>) =>
  `likely ${formatNumber(r.low)}–${formatNumber(r.high)}`;

/** "12 won, 3 lost, 1 drawn". */
export function recordWords(r: Pick<RatingView, 'wins' | 'losses' | 'draws'>) {
  const parts = [`${r.wins} won`, `${r.losses} lost`];
  if (r.draws > 0) parts.push(`${r.draws} drawn`);
  return parts.join(', ');
}

/** The repeat-pair factor of a rated duel in words (null when it counted in full). */
export function factorWords(factor: number): string | null {
  if (factor >= 1) return null;
  if (factor <= 0)
    return 'Counted for nothing: you have met this player often this week. Try other opponents.';
  const share =
    factor === 0.5 ? 'half' : factor === 0.25 ? 'a quarter' : `${Math.round(factor * 100)} %`;
  return `Counted at ${share}: you have met this player often this week.`;
}

/** A signed whole number: "+16", "−8", "±0". */
export function signed(n: number): string {
  if (n === 0) return '±0';
  return n > 0 ? `+${formatNumber(n)}` : `−${formatNumber(-n)}`;
}
