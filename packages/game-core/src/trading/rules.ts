import type { SanctionKind } from '../social/sanctions.js';
import type { MaterialId } from '../world/materials.js';
import { itemBinding, type ItemBindingInput, type TradeCategory } from './binding.js';
import { tradingSwitchesOf, type TradeKind, type TradingSettings } from './settings.js';

/**
 * Trade rules and eligibility (ticket T.4, docs/TRADING.md "4. Anti-abuse rules" and "T.4 as
 * built"). One pure function, `tradeDecision`, answers whether account A may perform a trade
 * action with account B, and names every check that fails so the UI can say why in plain words.
 * Nothing here reads a clock or a database: the server passes the transaction's `now` (the window
 * rule), the settings it read inside the transaction (`loadTradingSettings(tx)`), both accounts'
 * standing and the relation between them.
 *
 * The matrix is data: `TRADE_ACTION_CHECKS` lists which checks each action runs, in order, and
 * `TRADE_SANCTION_BLOCKS` which sanctions block which actions. Stepping away (cancel, decline) and
 * looking (view) are always possible, whatever the switches, the relation or the standing: a muted
 * or trade-restricted player can still cancel and decline (TRADING.md "What blocks and sanctions
 * do"), and closing trading voids offers rather than trapping them.
 *
 * The thresholds are constants, exactly as TRADING.md specifies them (they are not admin
 * settings): an account 14 days old, a hero at level 15, a relation 7 days old. The numbers that
 * are settings (items per side, gold per offer, the weekly caps) come from `TradingSettings`.
 */

/** The offer lifecycle T.5 builds on. */
export const TRADE_ACTIONS = ['send', 'accept', 'decline', 'cancel', 'view'] as const;
export type TradeAction = (typeof TRADE_ACTIONS)[number];

/** The eligibility thresholds of TRADING.md "Eligibility" (constants, not settings). */
export const TRADE_ELIGIBILITY = Object.freeze({
  /** Both accounts at least this old. */
  minAccountAgeDays: 14,
  /** Both accounts own a hero at this level or higher. */
  minHeroLevel: 15,
  /** Friends accepted, or guildmates together, at least this long. */
  minRelationAgeDays: 7,
});

const DAY_MS = 86_400_000;

/**
 * Materials that can never be traded: Gravewarden's seals are boss loot and gate the Ashen Pass
 * project (TRADING.md "Contents").
 */
export const UNTRADEABLE_MATERIALS: readonly MaterialId[] = ['gravewardenSeal'];

/**
 * Every named check, in the order they are run and listed. The party says whose fact it is:
 * `game` (the switches), `pair` (the relation), `you` (the acting account), `them` (the other
 * account) and `offer` (the contents).
 */
export const TRADE_CHECKS = [
  // The switches.
  'trading_off',
  // The relation.
  'self',
  'blocked',
  'no_relation',
  'relation_too_new',
  // Standing (run for the actor and, unless hidden, the other account).
  'account_too_new',
  'hero_too_low',
  'email_unverified',
  'suspended',
  'muted',
  'trade_restricted',
  // Ticket D.4: a test account (set by the admin CLI) never trades.
  'test_account',
  // The other account's standing, when the caller may not learn which rule fails (the
  // eligibility endpoint, docs/TRADING.md "T.4 as built": one bit, never the reason).
  'them_not_eligible',
  // The contents (send and accept).
  'empty_offer',
  'kind_off',
  'too_many_items',
  'gold_per_offer',
  'invalid_amount',
  'material_not_tradeable',
  'item_unprovenanced',
  'item_bound',
  'item_category_off',
  'item_locked',
  'item_stored',
  'item_on_shelf',
  'item_held',
] as const;
export type TradeCheckId = (typeof TRADE_CHECKS)[number];

export type TradeParty = 'game' | 'pair' | 'you' | 'them' | 'offer';

/** The standing checks, run per account. */
export const STANDING_CHECKS = [
  'account_too_new',
  'hero_too_low',
  'email_unverified',
  'suspended',
  'muted',
  'trade_restricted',
  'test_account',
] as const satisfies readonly TradeCheckId[];
export type StandingCheckId = (typeof STANDING_CHECKS)[number];

/** The contents checks, run on each side of an offer. */
export const OFFER_CHECKS = [
  'empty_offer',
  'kind_off',
  'too_many_items',
  'gold_per_offer',
  'invalid_amount',
  'material_not_tradeable',
  'item_unprovenanced',
  'item_bound',
  'item_category_off',
  'item_locked',
  'item_stored',
  'item_on_shelf',
  'item_held',
] as const satisfies readonly TradeCheckId[];

const SWITCH_AND_PAIR = [
  'trading_off',
  'self',
  'blocked',
  'no_relation',
  'relation_too_new',
] as const satisfies readonly TradeCheckId[];

/**
 * Which checks each action runs (the matrix, as data). Send and accept check everything again
 * (TRADING.md: "checked at send and at accept"); cancel, decline and view check nothing beyond
 * being a party to the offer, which is T.5's ownership check (`404` for anyone else).
 */
export const TRADE_ACTION_CHECKS: Readonly<Record<TradeAction, readonly TradeCheckId[]>> = {
  send: [...SWITCH_AND_PAIR, ...STANDING_CHECKS, 'them_not_eligible', ...OFFER_CHECKS],
  accept: [...SWITCH_AND_PAIR, ...STANDING_CHECKS, 'them_not_eligible', ...OFFER_CHECKS],
  decline: [],
  cancel: [],
  view: [],
};

/**
 * The sanctions that stop an account from sending or accepting (TRADING.md "What blocks and
 * sanctions do"): a mute ("can't send or accept offers; can still cancel and decline"), a
 * suspension and the trade restriction. A forced rename and hidden content don't touch trading.
 */
export const TRADE_SANCTION_CHECK: Readonly<Record<SanctionKind, StandingCheckId | null>> = {
  suspend: 'suspended',
  mute: 'muted',
  trade: 'trade_restricted',
  rename: null,
  hide: null,
};

/** One account's standing, as the server reads it. */
export interface TradeStanding {
  /** When the account was created. */
  createdAt: Date;
  /** The highest level among the account's heroes (0 without a hero). */
  highestHeroLevel: number;
  /** 5.7's `isEmailVerified`. */
  emailVerified: boolean;
  /** Kinds of the account's active sanctions at `now`. */
  sanctions: readonly SanctionKind[];
  /** Ticket D.4: a test account (admin CLI). Absent = not one. */
  testAccount?: boolean;
}

/**
 * The relation between the two accounts. `friendSince` is when the friendship was accepted,
 * `guildmatesSince` when the later of the two joined their shared guild (null when not friends,
 * not in one guild). A block either way wins over everything.
 */
export interface TradeRelationFacts {
  self: boolean;
  blocked: boolean;
  friendSince: Date | null;
  guildmatesSince: Date | null;
}

/** An item on one side of an offer: the binding inputs plus the item's state. */
export interface TradeItemFacts extends ItemBindingInput {
  id: string;
  /** T.1: no creation row in the audit log; refused and flagged. */
  unprovenanced?: boolean;
  locked?: boolean;
  /** In the per-hero Warehouse. */
  inWarehouse?: boolean;
  /** On the account shelf (T.3). */
  onShelf?: boolean;
  /** T.1's `hold_until` (received in a trade under 72 h ago). */
  holdUntil?: Date | string | null;
}

/** One side of an offer (what one hero gives). */
export interface TradeSideFacts {
  items: readonly TradeItemFacts[];
  materials: Readonly<Partial<Record<MaterialId, number>>>;
  gold: number;
}

/** The offer: `give` is what the sender puts in, `ask` what they ask the receiver for. */
export interface TradeOfferFacts {
  give: TradeSideFacts;
  ask: TradeSideFacts;
}

export interface TradeDecisionInput {
  action: TradeAction;
  settings: Readonly<TradingSettings>;
  now: Date;
  /** The account acting. */
  actor: TradeStanding;
  /**
   * The other account. `'hidden'` when the caller may learn only whether they can trade, not why
   * (any failure becomes one `them_not_eligible`); `null` when it must not be evaluated at all
   * (the eligibility endpoint for a relation that doesn't qualify).
   */
  counterpart: TradeStanding | 'hidden-eligible' | 'hidden-ineligible' | null;
  relation: TradeRelationFacts;
  /** For send and accept: the offer's contents. Without it the contents checks are skipped. */
  offer?: TradeOfferFacts;
}

export interface TradeRefusal {
  check: TradeCheckId;
  party: TradeParty;
  /** For `kind_off`: the kind; for item checks: the item's id; for materials: the material. */
  kind?: TradeKind;
  itemId?: string;
  materialId?: string;
  /** Which side of the offer (`give` = the sender's). */
  side?: 'give' | 'ask';
  /** For `item_category_off`: the closed categories. */
  categories?: TradeCategory[];
  /** For `relation_too_new`, `account_too_new`: when the rule will be met. */
  metAt?: string;
  /** For `item_unprovenanced`: the server must flag it (audit row, T.5). */
  flag?: true;
}

export interface TradeDecision {
  allowed: boolean;
  /** Every failing check, by party (game, pair, you, them, offer), then in `TRADE_CHECKS` order. */
  refusals: TradeRefusal[];
}

/** The relation's age-qualifying start: the older of the two ties, or null. */
export function tradeRelationSince(r: TradeRelationFacts): Date | null {
  const ties = [r.friendSince, r.guildmatesSince].filter((d): d is Date => d !== null);
  if (ties.length === 0) return null;
  return new Date(Math.min(...ties.map((d) => d.getTime())));
}

/** The kind of relation that matters to trading (`friend` wins over `guildmate` when both). */
export function tradeRelationKind(
  r: TradeRelationFacts,
): 'self' | 'blocked' | 'friend' | 'guildmate' | 'none' {
  if (r.self) return 'self';
  if (r.blocked) return 'blocked';
  if (r.friendSince && r.guildmatesSince) {
    return r.friendSince <= r.guildmatesSince ? 'friend' : 'guildmate';
  }
  if (r.friendSince) return 'friend';
  if (r.guildmatesSince) return 'guildmate';
  return 'none';
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The standing checks one account fails at `now`, in order. */
export function standingRefusals(
  s: TradeStanding,
  now: Date,
): { check: StandingCheckId; metAt?: string }[] {
  const out: { check: StandingCheckId; metAt?: string }[] = [];
  const ageReachedAt = s.createdAt.getTime() + TRADE_ELIGIBILITY.minAccountAgeDays * DAY_MS;
  if (now.getTime() < ageReachedAt)
    out.push({ check: 'account_too_new', metAt: iso(ageReachedAt) });
  if (s.highestHeroLevel < TRADE_ELIGIBILITY.minHeroLevel) out.push({ check: 'hero_too_low' });
  if (!s.emailVerified) out.push({ check: 'email_unverified' });
  for (const check of ['suspended', 'muted', 'trade_restricted'] as const) {
    if (s.sanctions.some((k) => TRADE_SANCTION_CHECK[k] === check)) out.push({ check });
  }
  if (s.testAccount === true) out.push({ check: 'test_account' });
  return out;
}

function sideRefusals(
  side: TradeSideFacts,
  which: 'give' | 'ask',
  settings: Readonly<TradingSettings>,
  now: Date,
): TradeRefusal[] {
  const out: TradeRefusal[] = [];
  const at = (check: TradeCheckId, extra: Partial<TradeRefusal> = {}) =>
    out.push({ check, party: 'offer', side: which, ...extra });
  const materials = Object.entries(side.materials) as [MaterialId, number][];
  const used: Record<TradeKind, boolean> = {
    items: side.items.length > 0,
    materials: materials.some(([, q]) => q !== 0),
    gold: side.gold !== 0,
  };
  for (const kind of ['items', 'materials', 'gold'] as const) {
    if (used[kind] && !settings.trade[kind]) at('kind_off', { kind });
  }
  if (side.items.length > settings.limits.itemsPerSide) at('too_many_items');
  if (side.gold > settings.limits.goldPerOffer) at('gold_per_offer');
  const badAmount = (n: number) => !Number.isSafeInteger(n) || n < 0;
  if (badAmount(side.gold) || materials.some(([, q]) => badAmount(q))) at('invalid_amount');
  else if (new Set(side.items.map((i) => i.id)).size !== side.items.length) at('invalid_amount');
  for (const [materialId, q] of materials) {
    if (q > 0 && UNTRADEABLE_MATERIALS.includes(materialId)) {
      at('material_not_tradeable', { materialId });
    }
  }
  const switches = tradingSwitchesOf(settings);
  // The binding is judged with the category switches only: the master and "Trade: items" are
  // their own checks above, so an item is named for what is wrong with *it*.
  const categoryOnly = { ...switches, trading: true, items: true };
  for (const item of side.items) {
    const itemId = item.id;
    if (item.unprovenanced) at('item_unprovenanced', { itemId, flag: true });
    const b = itemBinding(item, categoryOnly);
    if (b.binding === 'account') at('item_bound', { itemId });
    else if (!b.tradeable) {
      at('item_category_off', {
        itemId,
        categories: b.categories.filter((c) => !switches.categories[c]),
      });
    }
    if (item.locked) at('item_locked', { itemId });
    if (item.inWarehouse) at('item_stored', { itemId });
    if (item.onShelf) at('item_on_shelf', { itemId });
    const hold = item.holdUntil ? new Date(item.holdUntil).getTime() : null;
    if (hold !== null && hold > now.getTime()) at('item_held', { itemId });
  }
  return out;
}

const isEmpty = (s: TradeSideFacts) =>
  s.items.length === 0 && s.gold === 0 && Object.values(s.materials).every((q) => !q);

/**
 * The permission matrix (docs/TRADING.md "T.4 as built"). Runs the action's checks in order and
 * returns every failure. Allowed only when nothing fails.
 */
export function tradeDecision(input: TradeDecisionInput): TradeDecision {
  const { action, settings, now, relation } = input;
  const run = new Set(TRADE_ACTION_CHECKS[action]);
  if (run.size === 0) return { allowed: true, refusals: [] };
  const found: TradeRefusal[] = [];

  if (run.has('trading_off') && !settings.trading)
    found.push({ check: 'trading_off', party: 'game' });

  const kind = tradeRelationKind(relation);
  if (kind === 'self') found.push({ check: 'self', party: 'pair' });
  else if (kind === 'blocked') found.push({ check: 'blocked', party: 'pair' });
  else if (kind === 'none') found.push({ check: 'no_relation', party: 'pair' });
  else {
    const since = tradeRelationSince(relation)!.getTime();
    const metAt = since + TRADE_ELIGIBILITY.minRelationAgeDays * DAY_MS;
    if (now.getTime() < metAt) {
      found.push({ check: 'relation_too_new', party: 'pair', metAt: iso(metAt) });
    }
  }

  for (const r of standingRefusals(input.actor, now)) found.push({ ...r, party: 'you' });

  const c = input.counterpart;
  if (c === 'hidden-ineligible') found.push({ check: 'them_not_eligible', party: 'them' });
  else if (c && typeof c === 'object') {
    // `account_too_new`'s date is the other account's creation: never handed on.
    for (const r of standingRefusals(c, now)) found.push({ check: r.check, party: 'them' });
  }

  if (input.offer) {
    const { give, ask } = input.offer;
    if (isEmpty(give) && isEmpty(ask)) found.push({ check: 'empty_offer', party: 'offer' });
    found.push(...sideRefusals(give, 'give', settings, now));
    found.push(...sideRefusals(ask, 'ask', settings, now));
  }

  const PARTY_ORDER: TradeParty[] = ['game', 'pair', 'you', 'them', 'offer'];
  const order = (r: TradeRefusal) =>
    PARTY_ORDER.indexOf(r.party) * TRADE_CHECKS.length + TRADE_CHECKS.indexOf(r.check);
  const refusals = found.filter((r) => run.has(r.check)).sort((a, b) => order(a) - order(b));
  return { allowed: refusals.length === 0, refusals };
}

/**
 * Plain words for each check (docs/TRADING.md "T.4 as built"). `you` speaks about the reader,
 * `them` about the other player (only ever the generic line: never which rule they miss).
 */
export const TRADE_CHECK_TEXT: Readonly<Record<TradeCheckId, string>> = {
  trading_off: 'Trading between players is not open yet.',
  self: 'You can’t trade with yourself. Use the account shelf to move things between your heroes.',
  blocked: 'One of you has blocked the other.',
  no_relation: 'You can only trade with a friend or a guildmate.',
  relation_too_new: 'You need to have been friends or guildmates for at least 7 days.',
  account_too_new: 'Your account must be at least 14 days old.',
  hero_too_low: 'One of your heroes must reach level 15.',
  email_unverified: 'Verify your email address first.',
  suspended: 'Your account is suspended.',
  muted: 'You are muted: you can’t send or accept offers, but you can still cancel and decline.',
  trade_restricted: 'A moderator has restricted your trading.',
  test_account: 'Test accounts can’t trade.',
  them_not_eligible: 'They can’t trade right now.',
  empty_offer: 'Put something into the offer, or ask for something.',
  kind_off: 'Trading of this kind is paused.',
  too_many_items: 'Too many items on one side of the offer.',
  gold_per_offer: 'Too much gold for one offer.',
  invalid_amount: 'An amount in the offer is not valid.',
  material_not_tradeable: 'This material can never be traded.',
  item_unprovenanced:
    'This item can’t be traded: its origin isn’t on record. The wardens will look into it.',
  item_bound: 'This item is bound to its account.',
  item_category_off: 'Items of this kind can’t be traded right now.',
  item_locked: 'Unlock this item before offering it.',
  item_stored: 'Take this item out of the Warehouse first.',
  item_on_shelf: 'Take this item off the account shelf first.',
  item_held: 'This item was received in a trade less than 72 hours ago.',
};

/**
 * The words for a refusal, seen by the actor. A refusal about the other account always reads as
 * the generic `them_not_eligible` line: which rule they miss (age, level, email, a sanction) is
 * theirs to know, not the actor's.
 */
export function tradeRefusalText(r: TradeRefusal): string {
  return TRADE_CHECK_TEXT[r.party === 'them' ? 'them_not_eligible' : r.check];
}
