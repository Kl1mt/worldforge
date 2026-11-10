import type { BossModifierInfo } from '../game/bossModifier';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuildStanding, MaterialId } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { Character } from '../characters/api';
import { describeSocialFailure } from './api';

/** Ticket 4.9: the weekly guild boss as `GET /api/guild/boss` returns it. */
export interface GuildBossStage {
  stage: number;
  name: string;
  threshold: number;
  reward: { gold: number; materials: Partial<Record<MaterialId, number>> };
}

export interface GuildBossBoardRow {
  rank: number;
  player: { handle: string; displayName: string | null } | null;
  you: boolean;
  former: boolean;
  blocked: boolean;
  damage: number;
  attempts: number;
}

export interface GuildBossReward {
  week: string;
  stage: number;
  stageName: string;
  bossName: string;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
  guildName: string;
  guildTag: string;
}

export interface GuildBossState {
  now: string;
  week: { key: string; startsAt: string; endsAt: string };
  boss: {
    id: string;
    name: string;
    description: string;
    assetId: string;
    levelOffset: number;
    fightMs: number;
    minLevel: number;
    attemptDamageCap: number;
    stages: GuildBossStage[];
  };
  /** Ticket 6.3: this week's boss modifier (an attempt made now fights it). */
  bossModifier: BossModifierInfo;
  attemptsPerWeek: number;
  me: {
    attemptsUsed: number;
    attemptsLeft: number;
    attempts: {
      attemptNo: number;
      damage: number;
      counted: number;
      end: 'fell' | 'endured';
      heroName: string | null;
      forThisGuild: boolean;
      at: string;
    }[];
    rewards: GuildBossReward[];
    pendingStages: number[];
  };
  guild: {
    handle: string;
    name: string;
    tag: string;
    role: GuildStanding;
    total: number;
    stage: number;
    attempts: number;
    reached: { stage: number; reachedAt: string }[];
    board: GuildBossBoardRow[];
  } | null;
}

export interface GuildBossAttempt {
  id: string;
  week: string;
  attemptNo: number;
  bossLevel: number;
  /** Ticket 6.3: the modifier of the attempt's week (null before 6.3). */
  bossModifier: BossModifierInfo | null;
  heroName: string;
  classId: string;
  level: number;
  damage: number;
  counted: number;
  end: 'fell' | 'endured';
  durationMs: number;
  enrageAtMs: number;
  startHealth: number;
  events: { t: number; type: string; damage?: number; crit?: boolean; health?: number }[];
  newStages: number[];
  earnedStages: number[];
}

export const guildBossApi = {
  state: (signal?: AbortSignal): Promise<ApiResult<GuildBossState>> =>
    apiRequest('/guild/boss', signal ? { signal } : {}),
  /** A value operation: keep `key` for retries of the same attempt. */
  attempt: (
    characterId: string,
    key: string,
  ): Promise<ApiResult<{ attempt: GuildBossAttempt; state: GuildBossState }>> =>
    apiRequest('/guild/boss/attempts', {
      method: 'POST',
      body: { characterId },
      headers: { 'idempotency-key': key },
    }),
  claim: (
    characterId: string,
    key: string,
  ): Promise<
    ApiResult<{
      claimed: { gold: number; materials: Partial<Record<MaterialId, number>> };
      character: Character;
    }>
  > =>
    apiRequest('/guild/boss/claim', {
      method: 'POST',
      body: { characterId },
      headers: { 'idempotency-key': key },
    }),
};

export function describeGuildBossFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'no_attempts_left':
    case 'hero_too_low':
    case 'nothing_to_claim':
    case 'not_in_guild':
      return error.message;
    case 'not_found':
      return 'That hero is not yours to send.';
    case 'rate_limited':
      return `Too many guild actions in a short time. Try again in ${error.retryAfterSeconds ?? 60} seconds.`;
    default:
      return describeSocialFailure(error);
  }
}

export type GuildBossLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; view: GuildBossState; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/**
 * The guild boss panel's state: loaded on mount and refreshed every two minutes while open (one
 * small read; the board only changes when someone fights), and at once after an attempt or claim.
 * A failed refresh keeps the last board and marks it stale.
 */
export function useGuildBoss(pollMs = 120_000) {
  const [state, setState] = useState<GuildBossLoad>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const last = useRef<GuildBossState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      guildBossApi.state(controller.signal).then(
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
  }, [tick, pollMs]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  /** Show a state the server just returned (after an attempt) without another request. */
  const show = useCallback((view: GuildBossState) => {
    last.current = view;
    setState({ kind: 'ready', view, stale: false });
  }, []);
  return { state, reload, show };
}

/** "2 d 4 h", "5 h 12 min", "12 min", "under a minute" until `iso`. */
export function untilText(iso: string, nowMs: number): string {
  const ms = Date.parse(iso) - nowMs;
  if (ms < 60_000) return 'under a minute';
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} d ${h} h`;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/**
 * How far the guild is along the stage track: each stage is an equal segment, filled in
 * proportion within the current one (stages grow steeply, so a linear bar would hide the early
 * ones). 0…1.
 */
export function trackProgress(total: number, thresholds: readonly number[]): number {
  const n = thresholds.length;
  if (n === 0) return 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = thresholds[i]!;
    if (total < t) return (i + (total - prev) / (t - prev)) / n;
    prev = t;
  }
  return 1;
}
