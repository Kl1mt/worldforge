import { useCallback, useEffect, useState } from 'react';
import type { ClassId, DuelEvent, DuelOutcome, ItemRejection } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import { describeSocialFailure } from './api';

/** Ticket 5.5: the arena as the server returns it (docs/PVP.md "The arena"). */

export interface ArenaPlayer {
  handle: string;
  displayName: string | null;
  profile: boolean;
}

export interface ArenaHero {
  name: string | null;
  classId: ClassId;
  level: number;
}

export interface ArenaDefence {
  defenceId: string;
  heroName: string;
  classId: ClassId;
  level: number;
  bracketId: string;
  setAt: string;
  items: number;
  rejected: ItemRejection[];
  outdated: boolean;
}

export interface ArenaOpponent {
  defenceId: string;
  player: ArenaPlayer;
  hero: ArenaHero;
  bracketId: string;
  setOn: string;
}

export interface ArenaState {
  now: string;
  day: { key: string; resetsAt: string };
  rules: { ratedPerDay: number; minLevel: number; rulesVersion: number; offerRefreshMs: number };
  hero: {
    characterId: string;
    name: string;
    classId: ClassId;
    level: number;
    bracket: { id: string; label: string };
    ratedOpen: boolean;
  };
  defence: ArenaDefence | null;
  rated: {
    used: number;
    left: number;
    offer: { offeredAt: string; refreshableAt: string; opponents: ArenaOpponent[] } | null;
  };
}

export type StatLine = Record<
  | 'health'
  | 'physicalDamage'
  | 'magicDamage'
  | 'attackSpeed'
  | 'critChance'
  | 'critDamage'
  | 'armor'
  | 'resistance',
  number
>;

export interface DuelSideView {
  player: ArenaPlayer | null;
  blocked: boolean;
  hero: ArenaHero;
  maxHealth: number;
  health: number;
  attacks: number;
  crits: number;
  damageDealt: number;
  stats: StatLine;
  pveStats: StatLine | null;
}

export type DuelSide = 'challenger' | 'defender';

export interface DuelView {
  id: string;
  kind: 'rated' | 'friendly';
  bracketId: string;
  bracketLabel: string;
  rulesVersion: number;
  you: DuelSide;
  result: 'won' | 'lost' | 'draw';
  outcome: DuelOutcome;
  reason: 'defeat' | 'timeLimit';
  durationMs: number;
  foughtAt: string;
  defenceSetOn: string;
  challenger: DuelSideView;
  defender: DuelSideView;
  events: DuelEvent[];
}

export interface DuelSummary {
  id: string;
  kind: 'rated' | 'friendly';
  you: DuelSide;
  result: 'won' | 'lost' | 'draw';
  bracketId: string;
  foughtAt: string;
  yourHero: ArenaHero;
  opponent: { player: ArenaPlayer | null; blocked: boolean; hero: ArenaHero };
}

export interface FriendlyOpponent {
  player: ArenaPlayer;
  relation: 'friend' | 'guildmate';
  defences: { defenceId: string; hero: ArenaHero; bracketId: string; setOn: string }[];
}

const json = (body: object) => ({ method: 'POST' as const, body });

export const arenaApi = {
  state: (characterId: string, signal?: AbortSignal): Promise<ApiResult<ArenaState>> =>
    apiRequest(`/arena?characterId=${encodeURIComponent(characterId)}`, signal ? { signal } : {}),
  setDefence: (characterId: string): Promise<ApiResult<ArenaState>> =>
    apiRequest('/arena/defence', json({ characterId })),
  drawOpponents: (characterId: string): Promise<ApiResult<ArenaState>> =>
    apiRequest('/arena/opponents', json({ characterId })),
  /** Keep `key` for retries of the same challenge (the server replays the stored duel). */
  challenge: (
    characterId: string,
    defenceId: string,
    kind: 'rated' | 'friendly',
    key: string,
  ): Promise<ApiResult<{ duel: DuelView }>> =>
    apiRequest('/arena/duels', {
      method: 'POST',
      body: { characterId, defenceId, kind },
      headers: { 'idempotency-key': key },
    }),
  history: (
    cursor?: string,
  ): Promise<ApiResult<{ duels: DuelSummary[]; nextCursor: string | null }>> =>
    apiRequest(`/arena/duels?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  duel: (duelId: string): Promise<ApiResult<{ duel: DuelView }>> =>
    apiRequest(`/arena/duels/${encodeURIComponent(duelId)}`),
  friendly: (): Promise<ApiResult<{ opponents: FriendlyOpponent[] }>> =>
    apiRequest('/arena/friendly'),
};

export function describeArenaFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'level_too_low':
    case 'no_duels_left':
    case 'wrong_bracket':
    case 'not_friend_or_guildmate':
    case 'cannot_target_self':
    case 'not_offered':
      return error.message;
    case 'offer_fresh':
      return `These opponents are still fresh. Fight one, or ask again in ${Math.ceil((error.retryAfterSeconds ?? 60) / 60)} min.`;
    case 'not_found':
      return 'That opponent has left the arena.';
    case 'rate_limited':
      return `Too many duels in a short time. Try again in ${error.retryAfterSeconds ?? 60} seconds.`;
    case 'network':
      return 'The arena is out of reach. Check your connection and try again.';
    default:
      return describeSocialFailure(error);
  }
}

export type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: ApiFailure };

/** The arena state of one hero; reloaded on demand (nothing changes it but the player). */
export function useArena(characterId: string) {
  const [state, setState] = useState<Load<ArenaState>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    arenaApi.state(characterId, controller.signal).then(
      (res) =>
        setState(
          res.ok ? { kind: 'ready', value: res.value } : { kind: 'error', error: res.error },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [characterId, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const show = useCallback((value: ArenaState) => setState({ kind: 'ready', value }), []);
  return { state, reload, show };
}

/**
 * A list that loads once and on `reload` (history, the friendly list). Pass a module-level
 * loader (a stable function), e.g. `loadDuelHistory`.
 */
export function useLoad<T>(load: () => Promise<ApiResult<T>>) {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void load().then((res) => {
      if (live)
        setState(
          res.ok ? { kind: 'ready', value: res.value } : { kind: 'error', error: res.error },
        );
    });
    return () => {
      live = false;
    };
  }, [load, tick]);
  return { state, reload: useCallback(() => setTick((n) => n + 1), []) };
}

export const loadDuelHistory = () => arenaApi.history();
export const loadFriendly = () => arenaApi.friendly();

/** The log as plain lines, from the viewer's side ("you" / the opponent's name). */
export function duelLogLines(
  duel: Pick<DuelView, 'events' | 'you' | 'challenger' | 'defender'>,
  names: Record<DuelSide, string>,
): { t: number; text: string; tone: 'you' | 'them' | 'plain' | 'end'; crit?: boolean }[] {
  const other = (s: DuelSide): DuelSide => (s === 'challenger' ? 'defender' : 'challenger');
  const tone = (s: DuelSide) => (s === duel.you ? 'you' : 'them');
  const out: ReturnType<typeof duelLogLines> = [];
  for (const e of duel.events) {
    switch (e.type) {
      case 'start':
        out.push({
          t: e.t,
          tone: 'plain',
          text: `${names[e.initiative]} wins the coin and strikes first when both strike at once.`,
        });
        break;
      case 'attack':
        out.push({
          t: e.t,
          tone: tone(e.side),
          crit: e.crit,
          text: `${names[e.side]} ${e.skill ? 'uses the class skill' : 'strikes'} for ${e.damage}${e.crit ? ' (critical)' : ''}. ${names[other(e.side)]}: ${e.health} left.`,
        });
        break;
      case 'thorns':
        out.push({
          t: e.t,
          tone: tone(e.side),
          text: `Thorns of ${names[e.side]} bite back for ${e.damage}. ${names[other(e.side)]}: ${e.health} left.`,
        });
        break;
      case 'suddenDeath':
        out.push({ t: e.t, tone: 'plain', text: 'Sudden death: every blow grows stronger.' });
        break;
      case 'defeat':
        out.push({ t: e.t, tone: 'end', text: `${names[e.side]} falls.` });
        break;
      case 'timeLimit':
        out.push({ t: e.t, tone: 'end', text: 'Time is up: the larger share of health wins.' });
        break;
      case 'end':
        out.push({
          t: e.t,
          tone: 'end',
          text:
            e.outcome === 'draw'
              ? 'A draw: both stand with the same share of health.'
              : `${names[e.outcome]} wins.`,
        });
        break;
    }
  }
  return out;
}
