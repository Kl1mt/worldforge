import type { MaterialId } from '@worldforge/game-core';
import type { ItemDto } from '../game/api';
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
  mythicVoid: 'Mythic, Void or Prismatic items',
  gold: 'Gold',
  commonMaterials: 'Common materials',
  soulShards: 'Soul shards',
  abbeySilver: 'Abbey silver',
};

// ---------------------------------------------------------------------------------------------
// Ticket T.5: offers (docs/API_CONVENTIONS.md "Trading").
// ---------------------------------------------------------------------------------------------

export interface TradeMaterialLine {
  materialId: MaterialId;
  quantity: number;
}

export interface TradeSide {
  items: ItemDto[];
  gold: number;
  materials: TradeMaterialLine[];
}

export interface TradeHero {
  id?: string;
  name: string;
  classId: string;
  level: number;
}

export type TradeOfferStatus = 'open' | 'accepted' | 'cancelled' | 'declined' | 'expired' | 'void';

export interface TradeOffer {
  id: string;
  status: TradeOfferStatus;
  role: 'sender' | 'receiver';
  with: { handle: string; displayName: string | null };
  yourHero: (TradeHero & { id: string }) | null;
  theirHero: TradeHero | null;
  /** What the sender gives (in escrow while open). */
  give: TradeSide;
  /** What the sender asks of the receiver. */
  ask: TradeSide;
  gift: boolean;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  heldUntil: string | null;
  endText: string | null;
  /** Ticket T.6: a moderator reversed this trade (when, why, and what it means). */
  reversal?: { at: string; reason: string; text: string } | null;
}

export interface TradeHold {
  characterId: string;
  heroName: string;
  gold: number;
  materials: TradeMaterialLine[];
  items: number;
  heldUntil: string;
}

export interface TradeInbox {
  open: boolean;
  received: TradeOffer[];
  sent: TradeOffer[];
  recent: TradeOffer[];
  holds: TradeHold[];
  pollMs: number;
}

export interface TradeOfferReason extends TradeReason {
  side?: 'give' | 'ask';
  itemId?: string;
}

export interface TradeOfferDetail {
  offer: TradeOffer;
  decision: { allowed: boolean; reasons: TradeOfferReason[] } | null;
}

export interface TradeHeroOption {
  id: string;
  name: string;
  classId: string;
  level: number;
  gold: number;
  heldGold: number;
  materials: (TradeMaterialLine & { held: number })[];
  items: ItemDto[];
}

export interface TradePartner {
  handle: string;
  displayName: string | null;
  relation: string;
  allowed: boolean;
  reasons: TradeOfferReason[];
  heroes?: { id: string; name: string; classId: string; level: number; items: ItemDto[] }[];
}

export interface TradeSideDraft {
  itemIds: string[];
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
}

const o = (signal?: AbortSignal) => (signal ? { signal } : {});
const sideBody = (s: TradeSideDraft) => ({
  ...(s.itemIds.length ? { itemIds: s.itemIds } : {}),
  ...(s.gold > 0 ? { gold: s.gold } : {}),
  ...(Object.values(s.materials).some((q) => (q ?? 0) > 0)
    ? {
        materials: Object.fromEntries(Object.entries(s.materials).filter(([, q]) => (q ?? 0) > 0)),
      }
    : {}),
});

export const offersApi = {
  inbox: (signal?: AbortSignal): Promise<ApiResult<TradeInbox>> =>
    apiRequest('/trading/offers', o(signal)),
  history: (before?: string, signal?: AbortSignal) =>
    apiRequest<{ offers: TradeOffer[]; nextCursor: string | null }>(
      `/trading/offers/history${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      o(signal),
    ),
  detail: (id: string, signal?: AbortSignal): Promise<ApiResult<TradeOfferDetail>> =>
    apiRequest(`/trading/offers/${encodeURIComponent(id)}`, o(signal)),
  heroes: (signal?: AbortSignal) =>
    apiRequest<{ heroes: TradeHeroOption[] }>('/trading/heroes', o(signal)),
  partners: (signal?: AbortSignal) =>
    apiRequest<{ partners: TradePartner[] }>('/trading/partners', o(signal)),
  partner: (handle: string, signal?: AbortSignal) =>
    apiRequest<TradePartner>(`/trading/partners/${encodeURIComponent(handle)}`, o(signal)),
  send: (
    body: {
      to: string;
      characterId: string;
      receiverCharacterId?: string;
      give: TradeSideDraft;
      ask: TradeSideDraft;
    },
    key: string,
  ): Promise<ApiResult<TradeOffer>> =>
    apiRequest('/trading/offers', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: {
        to: body.to,
        characterId: body.characterId,
        ...(body.receiverCharacterId ? { receiverCharacterId: body.receiverCharacterId } : {}),
        give: sideBody(body.give),
        ask: sideBody(body.ask),
      },
    }),
  act: (
    id: string,
    action: 'accept' | 'decline' | 'cancel',
    key: string,
    characterId?: string,
  ): Promise<ApiResult<TradeOffer>> =>
    apiRequest(`/trading/offers/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: characterId ? { characterId } : {},
    }),
};

/** Plain words for a refused trade action (the server's reasons first). */
export function describeOfferFailure(error: ApiFailure): string[] {
  const details = (error.details ?? {}) as {
    reasons?: { text: string }[];
    refusals?: { party: string }[];
    onHold?: number;
  };
  if (error.code === 'trade_refused' && details.reasons?.length) {
    return [...new Set(details.reasons.map((r) => r.text))];
  }
  if (error.code === 'trade_cap_reached') {
    return [
      'This trade would go over a weekly or daily trade limit. Limits reset on Monday (UTC).',
    ];
  }
  if (
    (error.code === 'insufficient_gold' || error.code === 'insufficient_materials') &&
    details.onHold
  ) {
    return [`${error.message} Some of it was received in a trade and is held for 72 hours.`];
  }
  if (error.code === 'network') return ['The server can’t be reached. Try again in a moment.'];
  if (error.code === 'rate_limited')
    return ['Too many trade actions. Wait a minute and try again.'];
  return [error.message];
}

export const OFFER_STATUS_WORDS: Record<TradeOfferStatus, string> = {
  open: 'Waiting for an answer',
  accepted: 'Traded',
  cancelled: 'Cancelled',
  declined: 'Declined',
  expired: 'Expired',
  void: 'Withdrawn',
};
