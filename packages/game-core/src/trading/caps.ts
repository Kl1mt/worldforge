import { guildBossWeek } from '../guild-boss/week.js';
import type { MaterialId } from '../world/materials.js';
import { itemTradeCategories } from './binding.js';
import type { TradeOfferFacts, TradeSideFacts } from './rules.js';
import type { TradingLimitId, TradingLimits } from './settings.js';

/**
 * Trade caps (ticket T.4, docs/TRADING.md "Per-account limits" and "T.4 as built"). Pure: which
 * counters an accepted offer moves, and whether they stay within the limits. The server keeps the
 * counters in `trade_counters` (one row per account, window, metric and direction) and calls
 * `checkTradeCaps` under the accounts' counter locks inside T.5's accept transaction.
 *
 * **Windows.** The existing boundary rules, in UTC: a **week** starts Monday 00:00:00.000 UTC
 * (4.9's `guildBossWeek`), a **day** at 00:00 UTC (5.5's duel day, 4.6's contribution window).
 * The window is the one holding the transaction's clock (the window rule): an accept at Sunday
 * 23:59:59.999 counts in the old week, one at Monday 00:00 in the new one, and the window is stored
 * with the counter, never recomputed. (TRADING.md first said "rolling 7 days"; fixed windows are
 * what every other cap in the game uses, they are exact under a row per window, and the player can
 * be told when they reset.)
 *
 * **Given and received are counted separately** for every weekly cap; "Completed trades per day"
 * counts each accepted trade once for each of the two accounts.
 */

export const TRADE_CAP_METRICS = [
  'trades',
  'epic',
  'legendarySet',
  'mythicVoid',
  'gold',
  'commonMaterials',
  'soulShards',
  'abbeySilver',
] as const;
export type TradeCapMetric = (typeof TRADE_CAP_METRICS)[number];

export type TradePeriod = 'day' | 'week';
/** `any` is for "trades": one per accepted trade, whichever side. */
export type TradeDirection = 'given' | 'received' | 'any';

export interface TradeCapInfo {
  period: TradePeriod;
  limit: TradingLimitId;
  directions: readonly TradeDirection[];
}

/** Which setting caps each counter, over which window, and in which directions (data). */
export const TRADE_CAPS: Readonly<Record<TradeCapMetric, Readonly<TradeCapInfo>>> = {
  trades: { period: 'day', limit: 'tradesPerDay', directions: ['any'] },
  epic: { period: 'week', limit: 'epicPerWeek', directions: ['given', 'received'] },
  legendarySet: {
    period: 'week',
    limit: 'legendarySetPerWeek',
    directions: ['given', 'received'],
  },
  mythicVoid: { period: 'week', limit: 'mythicVoidPerWeek', directions: ['given', 'received'] },
  gold: { period: 'week', limit: 'goldPerWeek', directions: ['given', 'received'] },
  commonMaterials: {
    period: 'week',
    limit: 'commonMaterialsPerWeek',
    directions: ['given', 'received'],
  },
  soulShards: { period: 'week', limit: 'soulShardsPerWeek', directions: ['given', 'received'] },
  abbeySilver: { period: 'week', limit: 'abbeySilverPerWeek', directions: ['given', 'received'] },
};

/** The cap group of each tradeable material (seals are never tradeable: `UNTRADEABLE_MATERIALS`). */
export const MATERIAL_CAP: Readonly<Partial<Record<MaterialId, TradeCapMetric>>> = {
  timber: 'commonMaterials',
  ashwort: 'commonMaterials',
  rawHide: 'commonMaterials',
  ironOre: 'commonMaterials',
  soulShard: 'soulShards',
  abbeySilver: 'abbeySilver',
};

export interface TradeWindow {
  /** `YYYY-MM-DD`: the day, or the Monday the week starts on. */
  key: string;
  startsAt: Date;
  endsAt: Date;
}

const DAY_MS = 86_400_000;

/** The day and the week holding `now` (UTC). */
export function tradeWindows(now: Date): Record<TradePeriod, TradeWindow> {
  const ms = now.getTime();
  const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
  const week = guildBossWeek(ms);
  return {
    day: {
      key: new Date(dayStart).toISOString().slice(0, 10),
      startsAt: new Date(dayStart),
      endsAt: new Date(dayStart + DAY_MS),
    },
    week: { key: week.key, startsAt: new Date(week.startMs), endsAt: new Date(week.endMs) },
  };
}

/** A counter key within the current windows: `metric:direction`. */
export type TradeCounterKey = `${TradeCapMetric}:${TradeDirection}`;
export type TradeCounterValues = Partial<Record<TradeCounterKey, number>>;

export function counterKey(metric: TradeCapMetric, direction: TradeDirection): TradeCounterKey {
  return `${metric}:${direction}`;
}

/** What one side of an offer moves, per weekly metric (items by rarity, gold, materials). */
export function capUsageOfSide(side: TradeSideFacts): Partial<Record<TradeCapMetric, number>> {
  const out: Partial<Record<TradeCapMetric, number>> = {};
  const add = (m: TradeCapMetric, n: number) => {
    if (n > 0) out[m] = (out[m] ?? 0) + n;
  };
  for (const item of side.items) {
    const cats = itemTradeCategories(item);
    if (cats.includes('epic')) add('epic', 1);
    // Mythic and Void count toward Legendary/set too ("it also counts toward the 3 above"); a
    // Void Mythic counts once toward Mythic/Void.
    if (cats.some((c) => c === 'legendary' || c === 'set' || c === 'mythic'))
      add('legendarySet', 1);
    if (cats.some((c) => c === 'mythic' || c === 'void')) add('mythicVoid', 1);
  }
  add('gold', side.gold);
  for (const [id, q] of Object.entries(side.materials) as [MaterialId, number][]) {
    const metric = MATERIAL_CAP[id];
    if (metric && q > 0) add(metric, q);
  }
  return out;
}

/**
 * The counters an accepted offer adds for one of its two accounts. The sender gives `give` and
 * receives `ask`; the receiver the other way round. Both count one trade for the day.
 */
export function tradeCapIncrements(
  offer: TradeOfferFacts,
  role: 'sender' | 'receiver',
): TradeCounterValues {
  const given = capUsageOfSide(role === 'sender' ? offer.give : offer.ask);
  const received = capUsageOfSide(role === 'sender' ? offer.ask : offer.give);
  const out: TradeCounterValues = { 'trades:any': 1 };
  for (const [m, n] of Object.entries(given)) out[counterKey(m as TradeCapMetric, 'given')] = n;
  for (const [m, n] of Object.entries(received)) {
    out[counterKey(m as TradeCapMetric, 'received')] = n;
  }
  return out;
}

export interface TradeCapRefusal {
  check: 'cap_reached';
  metric: TradeCapMetric;
  direction: TradeDirection;
  limit: TradingLimitId;
  /** Already counted in this window. */
  used: number;
  /** What this trade would add. */
  adding: number;
  max: number;
  /** When the window resets (ISO). */
  resetsAt: string;
}

/**
 * The caps `adding` would break on top of `used` (both for the windows holding `now`), in
 * `TRADE_CAP_METRICS` order. Empty when everything fits. A cap at 0 refuses any amount of its kind;
 * adding nothing never breaks a cap, even one already over (a lowered limit refuses new trades, it
 * never voids what was counted).
 */
export function checkTradeCaps(input: {
  used: TradeCounterValues;
  adding: TradeCounterValues;
  limits: Readonly<TradingLimits>;
  now: Date;
}): TradeCapRefusal[] {
  const windows = tradeWindows(input.now);
  const out: TradeCapRefusal[] = [];
  for (const metric of TRADE_CAP_METRICS) {
    const info = TRADE_CAPS[metric];
    for (const direction of info.directions) {
      const key = counterKey(metric, direction);
      const adding = input.adding[key] ?? 0;
      if (adding <= 0) continue;
      const used = input.used[key] ?? 0;
      const max = input.limits[info.limit];
      if (used + adding > max) {
        out.push({
          check: 'cap_reached',
          metric,
          direction,
          limit: info.limit,
          used,
          adding,
          max,
          resetsAt: windows[info.period].endsAt.toISOString(),
        });
      }
    }
  }
  return out;
}

/** Open offers are counted from the offers themselves (T.5), at send, against these limits. */
export function openOfferRefusal(
  open: { sent: number; received: number },
  limits: Readonly<TradingLimits>,
  role: 'sender' | 'receiver',
): { check: 'open_offers'; limit: TradingLimitId; open: number; max: number } | null {
  const limit = role === 'sender' ? 'openOffersSent' : 'openOffersReceived';
  const count = role === 'sender' ? open.sent : open.received;
  return count + 1 > limits[limit]
    ? { check: 'open_offers', limit, open: count, max: limits[limit] }
    : null;
}

/** Plain words for a cap refusal. */
export function tradeCapText(r: TradeCapRefusal, who: 'you' | 'them'): string {
  if (who === 'them') return 'This would take them over one of their trade limits for now.';
  const dir = r.direction === 'given' ? 'give' : 'receive';
  const words: Record<TradeCapMetric, string> = {
    trades: `You’ve completed ${r.used} of ${r.max} trades today.`,
    epic: `You can ${dir} ${r.max} Epic items a week.`,
    legendarySet: `You can ${dir} ${r.max} Legendary or set items a week (Mythic and Void count too).`,
    mythicVoid: `You can ${dir} ${r.max} Mythic or Void items a week.`,
    gold: `You can ${dir} ${r.max.toLocaleString('en-GB')} gold a week.`,
    commonMaterials: `You can ${dir} ${r.max} common materials a week.`,
    soulShards: `You can ${dir} ${r.max} soul shards a week.`,
    abbeySilver: `You can ${dir} ${r.max} Abbey silver a week.`,
  };
  return words[r.metric];
}
