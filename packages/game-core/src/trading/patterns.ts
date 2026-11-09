/**
 * The trade pattern report (ticket T.6, docs/TRADING.md "7. What can't be prevented, only
 * detected" and "T.6 as built"): the thresholds and flag rules behind the moderators' panel and
 * `pnpm admin:trading patterns`. Data, so a balance pass changes numbers here, not queries.
 * A flag only points a moderator at a case; it never sanctions on its own.
 */

export const TRADE_PATTERN_RULES = {
  /** The default window, in days (the panel and the command; at most `maxWindowDays`). */
  windowDays: 28,
  maxWindowDays: 90,
  /** A pair is listed from this many completed trades in the window. */
  minPairTrades: 2,
  /** One-way: every item, gold and material of the pair's trades went the same way. */
  oneWayMinTrades: 2,
  /** Only each other: both accounts traded with nobody else, and at least this often. */
  onlyEachOtherMinTrades: 2,
  /** New accounts: younger than this at the trade… */
  newAccountDays: 30,
  /** …that received at least one of these within the window. */
  newAccountItems: 3,
  newAccountGold: 5_000,
  newAccountMaterialUnits: 150,
  /** At a cap: weeks in the window where a weekly cap was reached, from this many. */
  capWeeks: 2,
  /** Repeated reversals: trades of the account reversed in the window, from this many. */
  repeatedReversals: 2,
  /** Unprovenanced items (`trade.flag`): flagged from the first. */
  flaggedItems: 1,
  /** An invite cluster: accounts from one invite that traded with each other, from this many. */
  inviteClusterAccounts: 3,
} as const;

export const TRADE_PAIR_FLAGS = ['oneWay', 'onlyEachOther', 'sameInvite', 'sameMailbox'] as const;
export type TradePairFlag = (typeof TRADE_PAIR_FLAGS)[number];

export const TRADE_ACCOUNT_FLAGS = [
  'newAccountReceiving',
  'atCap',
  'flaggedItems',
  'repeatedReversals',
] as const;
export type TradeAccountFlag = (typeof TRADE_ACCOUNT_FLAGS)[number];

/** What flowed one way between a pair (`a` → `b`), summed over the window. */
export interface TradeFlow {
  items: number;
  gold: number;
  materialUnits: number;
}

export interface TradePairFacts {
  trades: number;
  aToB: TradeFlow;
  bToA: TradeFlow;
  /** Distinct partners each account had in the window (this pair included). */
  partnersA: number;
  partnersB: number;
  sameInvite: boolean;
  sameMailbox: boolean;
}

const flowTotal = (f: TradeFlow) => f.items + f.gold + f.materialUnits;

export function tradePairFlags(p: TradePairFacts): TradePairFlag[] {
  const out: TradePairFlag[] = [];
  const r = TRADE_PATTERN_RULES;
  const ab = flowTotal(p.aToB);
  const ba = flowTotal(p.bToA);
  if (p.trades >= r.oneWayMinTrades && (ab === 0) !== (ba === 0)) out.push('oneWay');
  if (p.trades >= r.onlyEachOtherMinTrades && p.partnersA === 1 && p.partnersB === 1) {
    out.push('onlyEachOther');
  }
  if (p.sameInvite) out.push('sameInvite');
  if (p.sameMailbox) out.push('sameMailbox');
  return out;
}

export interface TradeAccountFacts {
  /** Received while the account was younger than `newAccountDays`. */
  receivedWhileNew: TradeFlow;
  /** Weeks in the window in which any weekly cap was reached (given or received). */
  weeksAtCap: number;
  /** `trade.flag` rows (unprovenanced items offered) in the window. */
  flaggedItems: number;
  /** Trades of this account reversed in the window. */
  reversals: number;
}

export function tradeAccountFlags(a: TradeAccountFacts): TradeAccountFlag[] {
  const r = TRADE_PATTERN_RULES;
  const out: TradeAccountFlag[] = [];
  const n = a.receivedWhileNew;
  if (
    n.items >= r.newAccountItems ||
    n.gold >= r.newAccountGold ||
    n.materialUnits >= r.newAccountMaterialUnits
  ) {
    out.push('newAccountReceiving');
  }
  if (a.weeksAtCap >= r.capWeeks) out.push('atCap');
  if (a.flaggedItems >= r.flaggedItems) out.push('flaggedItems');
  if (a.reversals >= r.repeatedReversals) out.push('repeatedReversals');
  return out;
}

/** Plain words for every flag (the panel, the command). */
export const TRADE_PATTERN_TEXT: Readonly<Record<TradePairFlag | TradeAccountFlag, string>> = {
  oneWay: 'Everything went one way: one of them only gave, the other only received.',
  onlyEachOther: 'Neither traded with anyone else in the window.',
  sameInvite: 'Both accounts were created with the same invite.',
  sameMailbox: 'Both accounts signed up with the same mailbox (variants of one address).',
  newAccountReceiving: 'Received a lot while the account was less than 30 days old.',
  atCap: 'Reached a weekly trade cap in two or more weeks.',
  flaggedItems: 'Offered an item whose origin is not in the audit log (refused and flagged).',
  repeatedReversals: 'Two or more of their trades were reversed by a moderator.',
};
