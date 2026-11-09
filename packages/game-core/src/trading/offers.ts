import type { MaterialId } from '../world/materials.js';
import { itemTradeCategories, type TradeCategory } from './binding.js';
import type { TradeSideFacts } from './rules.js';
import type { TradeKind, TradingSwitchPath } from './settings.js';

/**
 * Trade offers (ticket T.5, docs/TRADING.md "2. What a trade may contain, and the format" and
 * "T.5 as built"). Pure rules the server applies under its locks: how long an offer stays open,
 * how long received value is held, which open offers a switch turned off withdraws, and the plain
 * words for each way an offer ends.
 */

const HOUR_MS = 3_600_000;

/** An offer expires 48 hours after it was sent (TRADING.md, owner decision 4a). */
export const TRADE_OFFER_TTL_MS = 48 * HOUR_MS;

/** Everything received in a trade is held for 72 hours (TRADING.md "Cooldowns"). */
export const TRADE_HOLD_MS = 72 * HOUR_MS;

/** How an offer ends. */
export const TRADE_OFFER_ENDS = ['accepted', 'cancelled', 'declined', 'expired', 'void'] as const;
export type TradeOfferEnd = (typeof TRADE_OFFER_ENDS)[number];

/** Why an offer was voided (the `trade.void` audit row's `reason`). */
export const TRADE_VOID_CAUSES = ['switch', 'block', 'sanction', 'relation', 'deletion'] as const;
export type TradeVoidCause = (typeof TRADE_VOID_CAUSES)[number];

/** The kinds and item categories on both sides of an offer (what the switches can close). */
export interface OfferContentsSummary {
  kinds: TradeKind[];
  categories: TradeCategory[];
}

export function offerContents(sides: readonly TradeSideFacts[]): OfferContentsSummary {
  const kinds = new Set<TradeKind>();
  const categories = new Set<TradeCategory>();
  for (const side of sides) {
    if (side.items.length > 0) kinds.add('items');
    if (side.gold > 0) kinds.add('gold');
    if (Object.values(side.materials).some((q) => (q ?? 0) > 0)) kinds.add('materials');
    for (const item of side.items) for (const c of itemTradeCategories(item)) categories.add(c);
  }
  return { kinds: [...kinds], categories: [...categories] };
}

/**
 * The switches just turned off that withdraw an open offer (TRADING.md "Admin switches", last
 * column): the master voids every offer; a "Trade: …" switch the offers with that kind on either
 * side; a "Tradeable: …" switch the offers with an item of that category on either side. "Shelf:
 * …" switches and lowered limits never void an offer. Empty: the offer stays open.
 */
export function switchesVoiding(
  off: readonly TradingSwitchPath[],
  contents: OfferContentsSummary,
): TradingSwitchPath[] {
  return off.filter((path) => {
    if (path === 'trading') return true;
    const [group, key] = path.split('.') as [string, string];
    if (group === 'trade') return contents.kinds.includes(key as TradeKind);
    if (group === 'tradeable') return contents.categories.includes(key as TradeCategory);
    return false;
  });
}

const SWITCH_WORDS: Readonly<Record<TradingSwitchPath, string>> = {
  trading: 'trading',
  'trade.items': 'items',
  'trade.materials': 'materials',
  'trade.gold': 'gold',
  'tradeable.epic': 'Epic items',
  'tradeable.legendary': 'Legendary items',
  'tradeable.set': 'set pieces',
  'tradeable.mythic': 'Mythic items',
  'tradeable.void': 'Void items',
  'shelf.items': 'items on the shelf',
  'shelf.materials': 'materials on the shelf',
  'shelf.gold': 'gold on the shelf',
};

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The plain line both players see for an offer that ended without a trade. Nothing changed
 * hands, so nothing is held. A void never names a sanction or whose block it was.
 */
export function tradeEndText(
  end: Exclude<TradeOfferEnd, 'accepted'>,
  detail: { cause?: TradeVoidCause; switches?: readonly TradingSwitchPath[] } = {},
): string {
  switch (end) {
    case 'cancelled':
      return 'The offer was cancelled. Everything in it went back to the sender.';
    case 'declined':
      return 'The offer was declined. Everything in it went back to the sender.';
    case 'expired':
      return 'The offer expired after 48 hours. Everything in it went back to the sender.';
    case 'void': {
      if (detail.cause === 'switch') {
        const paths = detail.switches ?? [];
        if (paths.length === 0 || paths.includes('trading')) {
          return 'This offer was withdrawn: trading is paused. Everything in it went back to the sender.';
        }
        return `This offer was withdrawn: trading of ${listWords(paths.map((p) => SWITCH_WORDS[p]))} is paused. Everything in it went back to the sender.`;
      }
      if (detail.cause === 'deletion') {
        return 'This offer was withdrawn: a hero in it is gone. Everything in it went back to the sender.';
      }
      // A block, a relation that ended or a sanction: no reason that names the other player.
      return 'This offer was withdrawn: the two of you can’t trade right now. Everything in it went back to the sender.';
    }
  }
}

/** The release time of value received at `now`. */
export function holdUntil(now: Date): Date {
  return new Date(now.getTime() + TRADE_HOLD_MS);
}

/** An offer sent at `now` expires at this time. */
export function offerExpiresAt(now: Date): Date {
  return new Date(now.getTime() + TRADE_OFFER_TTL_MS);
}

/** Whether an open offer is past its expiry at `now` (the transaction's clock). */
export function isOfferExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** A side with positive material entries only, in a stable order. */
export function cleanSideMaterials(
  materials: Readonly<Partial<Record<MaterialId, number>>>,
): Partial<Record<MaterialId, number>> {
  const out: Partial<Record<MaterialId, number>> = {};
  for (const [id, q] of Object.entries(materials).sort(([a], [b]) => a.localeCompare(b))) {
    if ((q ?? 0) > 0) out[id as MaterialId] = q!;
  }
  return out;
}
