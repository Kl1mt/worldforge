import type {
  AccountRole,
  MaterialId,
  ReversalParty,
  TradeAccountFlag,
  TradePairFlag,
  TradeReversalCheck,
} from '@worldforge/game-core';
import type { ItemDto } from '../game/api';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { Sanction } from './api';

/**
 * Ticket T.6: the moderators' trade desk (docs/API_CONVENTIONS.md "Trade moderation"): the trade
 * history, one trade's case, its reversal and the pattern report. Staff only.
 */

export interface TradeWho {
  handle: string;
  displayName: string;
  role: AccountRole;
}

export interface ModTradeCount {
  items: number;
  gold: number;
  materialUnits: number;
  rarities: string[];
}

export type ModTradeStatus = 'open' | 'accepted' | 'cancelled' | 'declined' | 'expired' | 'void';

export interface ModTradeSummary {
  id: string;
  status: ModTradeStatus;
  kind: 'gift' | 'swap';
  sender: TradeWho;
  receiver: TradeWho;
  createdAt: string;
  closedAt: string | null;
  reversedAt: string | null;
  give: ModTradeCount;
  ask: ModTradeCount;
}

export interface MaterialLine {
  materialId: MaterialId;
  quantity: number;
}

export interface ModTradeSide {
  items: ItemDto[];
  gold: number;
  materials: MaterialLine[];
}

export interface ReversalRefusal {
  check: TradeReversalCheck;
  text: string;
  party?: ReversalParty;
  itemId?: string;
  materialId?: MaterialId;
  received?: number;
  available?: number;
  deadline?: string;
}

export interface ReturnMove {
  items: { id: string; worn: boolean; locked: boolean }[];
  gold: number;
  materials: MaterialLine[];
}

export interface TradeHeroRef {
  name: string;
  classId: string;
  level: number;
}

export interface ModTradeCase extends Omit<ModTradeSummary, 'give' | 'ask'> {
  relation: string;
  expiresAt: string;
  senderHero: TradeHeroRef | null;
  receiverHero: TradeHeroRef | null;
  give: ModTradeSide;
  ask: ModTradeSide;
  voidReason: string | null;
  heldUntil: string | null;
  reversal: {
    at: string;
    reason: string;
    by: { handle: string; displayName: string } | null;
  } | null;
  reversible: {
    possible: boolean;
    deadline: string | null;
    refusals: ReversalRefusal[];
    canAct: boolean;
    cannotAct: string | null;
  };
  moves: { toSender: ReturnMove; toReceiver: ReturnMove };
  holds: {
    party: ReversalParty;
    heldUntil: string;
    releasedAt: string | null;
    gold: number;
    materials: MaterialLine[];
    items: number;
  }[];
  trail: {
    event: string;
    at: string;
    by: { handle: string; displayName: string } | null;
    text: string;
  }[];
  reports: { open: number; reportId: string | null };
}

export type TradeListStatus = 'all' | 'open' | 'accepted' | 'reversed' | 'ended';

export interface TradeListFilter {
  handle?: string;
  with?: string;
  status?: TradeListStatus;
}

export type ReversalSanction = {
  handle: string;
  action: 'mute' | 'suspend' | 'restrictTrade';
  durationHours: number;
};

export interface TradeFlow {
  items: number;
  gold: number;
  materialUnits: number;
}

export interface TradePatternReport {
  windowDays: number;
  rules: Record<string, number>;
  totals: { trades: number; reversed: number; flaggedItems: number };
  pairs: {
    a: TradeWho;
    b: TradeWho;
    trades: number;
    aToB: TradeFlow;
    bToA: TradeFlow;
    reversed: number;
    firstOn: string;
    lastOn: string;
    flags: TradePairFlag[];
  }[];
  accounts: {
    who: TradeWho;
    trades: number;
    partners: number;
    given: TradeFlow;
    received: TradeFlow;
    receivedWhileNew: TradeFlow;
    accountAgeDays: number;
    weeksAtCap: number;
    capsReached: string[];
    flaggedItems: number;
    reversals: number;
    flags: TradeAccountFlag[];
  }[];
  inviteClusters: { members: TradeWho[]; trades: number }[];
}

const o = (signal?: AbortSignal) => (signal ? { signal } : {});

function query(f: TradeListFilter & { before?: string }): string {
  const p = new URLSearchParams();
  if (f.handle) p.set('handle', f.handle.trim().toLowerCase());
  if (f.with) p.set('with', f.with.trim().toLowerCase());
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.before) p.set('before', f.before);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const tradeModApi = {
  list: (
    f: TradeListFilter & { before?: string },
    signal?: AbortSignal,
  ): Promise<ApiResult<{ trades: ModTradeSummary[]; nextCursor: string | null }>> =>
    apiRequest(`/mod/trades${query(f)}`, o(signal)),
  case: (id: string, signal?: AbortSignal): Promise<ApiResult<ModTradeCase>> =>
    apiRequest(`/mod/trades/${encodeURIComponent(id)}`, o(signal)),
  reverse: (
    id: string,
    body: { reason: string; sanction?: ReversalSanction },
    key: string,
  ): Promise<
    ApiResult<{
      offerId: string;
      reversedAt: string;
      sanction: Sanction | null;
      case: ModTradeCase;
    }>
  > =>
    apiRequest(`/mod/trades/${encodeURIComponent(id)}/reverse`, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body,
    }),
  patterns: (days?: number, signal?: AbortSignal): Promise<ApiResult<TradePatternReport>> =>
    apiRequest(`/mod/trading/patterns${days ? `?days=${days}` : ''}`, o(signal)),
};

/** Plain words for a failed desk request. */
export function describeTradeModFailure(error: ApiFailure): string {
  if (error.code === 'not_found') return 'That trade isn’t in your reach (or doesn’t exist).';
  if (error.code === 'forbidden') return error.message;
  if (error.code === 'network') return 'The server can’t be reached. Try again in a moment.';
  if (error.code === 'rate_limited') return 'Too many requests. Wait a moment and try again.';
  if (error.code === 'validation_failed') return 'Check the reason: 3 to 300 characters, one line.';
  return error.message || 'The trade ledger could not be read. Try again.';
}

/** `#/moderation?trade=<offer id>` opens the trade desk on that trade. */
export function tradeCaseHref(offerId: string): string {
  return `#/moderation?trade=${encodeURIComponent(offerId)}`;
}

export function tradeIdFromHash(hash: string): string | null {
  if (!/^#\/?moderation\?/.test(hash)) return null;
  const id = new URLSearchParams(hash.slice(hash.indexOf('?'))).get('trade');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
}

export const TRADE_STATUS_WORDS: Record<ModTradeStatus, string> = {
  open: 'Open offer',
  accepted: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
  expired: 'Expired',
  void: 'Withdrawn',
};
