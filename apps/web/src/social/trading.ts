import type { TradeCapMetric, TradeDirection, TradeKind } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** Ticket T.4: `GET /api/trading/eligibility` (docs/API_CONVENTIONS.md). */
export interface TradeRequirement {
  id: 'accountAge' | 'heroLevel' | 'email' | 'standing';
  met: boolean;
  label: string;
  text: string;
  metAt?: string;
  value?: number;
  required?: number;
  sanctions?: string[];
}

export interface TradeReason {
  check: string;
  party: 'game' | 'pair' | 'you' | 'them' | 'offer';
  text: string;
  metAt?: string;
}

export interface TradeEligibility {
  trading: { open: boolean; kinds: Record<TradeKind, boolean> };
  you: { eligible: boolean; requirements: TradeRequirement[] };
  usage: {
    dayResetsAt: string;
    weekResetsAt: string;
    caps: {
      metric: TradeCapMetric;
      direction: TradeDirection;
      period: 'day' | 'week';
      used: number;
      max: number;
    }[];
  };
  with: {
    handle: string;
    relation: 'self' | 'blocked' | 'friend' | 'guildmate' | 'none';
    allowed: boolean;
    reasons: TradeReason[];
  } | null;
}

export const tradingApi = {
  eligibility: (handle?: string, signal?: AbortSignal): Promise<ApiResult<TradeEligibility>> =>
    apiRequest(
      `/trading/eligibility${handle ? `?handle=${encodeURIComponent(handle)}` : ''}`,
      signal ? { signal } : {},
    ),
};

export function describeTradingFailure(error: ApiFailure): string {
  if (error.code === 'not_found') return 'No player by that name.';
  if (error.code === 'network') return 'The server can’t be reached. Try again in a moment.';
  if (error.code === 'rate_limited') return 'Too many requests. Wait a moment and try again.';
  return 'The trading ledger could not be read. Try again.';
}

export const CAP_LABELS: Record<TradeCapMetric, string> = {
  trades: 'Completed trades today',
  epic: 'Epic items',
  legendarySet: 'Legendary and set items',
  mythicVoid: 'Mythic or Void items',
  gold: 'Gold',
  commonMaterials: 'Common materials',
  soulShards: 'Soul shards',
  abbeySilver: 'Abbey silver',
};
