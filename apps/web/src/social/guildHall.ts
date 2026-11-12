import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuildHallKind, TreasuryResource } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { Character } from '../characters/api';
import type { SeasonView } from './seasons';

/** Ticket 8.4: guild halls and the guild season roll (docs/GUILD_HALLS.md, LEADERBOARDS.md). */

export type HallLook = Record<GuildHallKind, string | null>;

export interface RollEntry {
  rank: number | null;
  guild: { handle: string | null; name: string; tag: string; emblem: string; look: HallLook };
  value: number;
  parts: { boss: number; pve: number; community: number };
  members: number;
  tier: string | null;
  listed?: boolean;
}

export interface GuildRollView {
  season: SeasonView | null;
  formula: {
    version: number;
    weights: {
      stagePoints: number[];
      pvePerMember: number;
      communityPerNeed: number;
      communityPerMemberCap: number;
      countedMembers: number;
    };
    rules: { countAfterDays: number; honourAfterDays: number; minMembers: number };
  };
  total: number;
  offset: number;
  entries: RollEntry[];
  mine: RollEntry | null;
}

export interface HallUpgradeView {
  id: string;
  kind: GuildHallKind;
  name: string;
  description: string;
  price: { gold: number; materials: Partial<Record<TreasuryResource, number>> };
  owned: boolean;
  boughtOn: string | null;
  affordable: boolean;
}

export interface TreasuryView {
  guild: { handle: string; name: string; tag: string; emblem: string; role: string };
  treasury: { gold: number; materials: Partial<Record<TreasuryResource, number>> };
  window: { day: string; resetsAt: string };
  resources: { resource: TreasuryResource; cap: number; givenToday: number; room: number }[];
  upgrades: HallUpgradeView[];
  look: HallLook;
  can: { contribute: boolean; buy: boolean; display: boolean };
  notice: string;
  honours: { season: number; tier: string; rank: number }[];
  standing: { season: SeasonView | null; entry: RollEntry | null };
  me: { joinedAt: string; countsFrom: string; honourBy: string | null };
  rules: { countAfterDays: number; honourAfterDays: number; minMembers: number };
}

const keyed = (key: string) => ({ 'idempotency-key': key });

export const guildHallApi = {
  hall: (signal?: AbortSignal): Promise<ApiResult<TreasuryView>> =>
    apiRequest('/guild/hall', signal ? { signal } : {}),
  look: (
    handle: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ look: HallLook; honours: TreasuryView['honours'] }>> =>
    apiRequest(`/guilds/${encodeURIComponent(handle)}/hall`, signal ? { signal } : {}),
  roll: (season: number | null, signal?: AbortSignal): Promise<ApiResult<GuildRollView>> =>
    apiRequest(
      `/leaderboards/guilds${season ? `?season=${season}` : ''}`,
      signal ? { signal } : {},
    ),
  contribute: (
    characterId: string,
    offer: { resource: TreasuryResource; amount: number }[],
    key: string,
  ): Promise<
    ApiResult<{
      accepted: { resource: TreasuryResource; amount: number }[];
      limited: Partial<Record<TreasuryResource, 'cap' | 'room'>>;
      character: Character;
      hall: TreasuryView;
    }>
  > =>
    apiRequest('/guild/hall/contribute', {
      method: 'POST',
      body: { characterId, offer, acknowledgeNoRefund: true },
      headers: keyed(key),
    }),
  buy: (upgradeId: string, key: string): Promise<ApiResult<TreasuryView>> =>
    apiRequest('/guild/hall/buy', { method: 'POST', body: { upgradeId }, headers: keyed(key) }),
  display: (change: Partial<HallLook>, key: string): Promise<ApiResult<TreasuryView>> =>
    apiRequest('/guild/hall/display', { method: 'POST', body: change, headers: keyed(key) }),
};

export function describeHallFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'treasury_capped':
      return 'The treasury can take none of that from you today: you have given your share, or the hall needs no more of it. The share resets at midnight (UTC).';
    case 'treasury_short':
      return 'The treasury does not hold enough for that yet.';
    case 'already_owned':
      return 'The hall has that already.';
    case 'not_owned':
      return 'The hall does not have that yet.';
    case 'guild_forbidden':
      return 'Only the leader and officers spend the treasury.';
    case 'not_in_guild':
      return 'You are not in a guild.';
    case 'test_account':
      return 'Test accounts use the treasury only in a guild of test accounts.';
    case 'insufficient_gold':
      return 'This hero does not carry that much gold.';
    case 'insufficient_materials':
      return 'This hero does not carry that much.';
    case 'no_refund_unacknowledged':
      return 'Confirm first that gifts are never given back.';
    case 'rate_limited':
      return 'Too many requests at once. Wait a moment and try again.';
    case 'network':
      return 'The herald could not be reached. Try again in a moment.';
    default:
      return error.message || 'That did not work. Try again.';
  }
}

export type Loadable<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/** Loads with `fetcher` (and on `reload`); a failed reload keeps the last value, marked stale. */
export function useLoad<T>(
  fetcher: (signal: AbortSignal) => Promise<ApiResult<T>>,
  deps: readonly unknown[],
  pollMs = 0,
) {
  const [state, setState] = useState<Loadable<T>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const last = useRef<T | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    const ctl = new AbortController();
    void fetcher(ctl.signal).then(
      (res) => {
        if (ctl.signal.aborted) return;
        if (res.ok) {
          last.current = res.value;
          setState({ kind: 'ready', value: res.value, stale: false });
        } else if (last.current && res.error.code !== 'not_in_guild') {
          setState({ kind: 'ready', value: last.current, stale: true });
        } else {
          setState({ kind: 'error', error: res.error });
        }
      },
      () => {
        // Aborted (unmounted or reloaded): nothing to show.
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  useEffect(() => {
    if (pollMs <= 0) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [pollMs, reload]);
  const set = useCallback((value: T) => {
    last.current = value;
    setState({ kind: 'ready', value, stale: false });
  }, []);
  return { state, reload, set };
}
