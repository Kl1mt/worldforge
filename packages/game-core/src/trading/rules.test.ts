import { describe, expect, it } from 'vitest';
import { SANCTION_KINDS, type SanctionKind } from '../social/sanctions.js';
import { DEFAULT_TRADING_SETTINGS, type TradingSettings } from './settings.js';
import {
  TRADE_ACTIONS,
  TRADE_ACTION_CHECKS,
  TRADE_CHECKS,
  TRADE_CHECK_TEXT,
  TRADE_ELIGIBILITY,
  TRADE_SANCTION_CHECK,
  tradeDecision,
  tradeRefusalText,
  tradeRelationKind,
  type TradeAction,
  type TradeCheckId,
  type TradeItemFacts,
  type TradeOfferFacts,
  type TradeRelationFacts,
  type TradeStanding,
} from './rules.js';

const DAY = 86_400_000;
const NOW = new Date('2031-05-14T12:00:00.000Z');
const ago = (days: number, ms = 0) => new Date(NOW.getTime() - days * DAY + ms);

const settingsWith = (over: (s: TradingSettings) => void): TradingSettings => {
  const s = JSON.parse(JSON.stringify(DEFAULT_TRADING_SETTINGS)) as TradingSettings;
  over(s);
  return s;
};
const CLOSED = settingsWith(() => {});
const OPEN = settingsWith((s) => {
  s.trading = true;
  s.trade = { items: true, materials: true, gold: true };
});

// ---- The dimensions, each with its hand-written expectation. --------------------------------

const ELIGIBLE: TradeStanding = {
  createdAt: ago(30),
  highestHeroLevel: 20,
  emailVerified: true,
  sanctions: [],
};

/** Standing → the check it fails (none for eligible and for sanctions that don't touch trading). */
const STANDINGS: Record<string, [TradeStanding, TradeCheckId | null]> = {
  eligible: [ELIGIBLE, null],
  tooNew: [{ ...ELIGIBLE, createdAt: ago(14, 1) }, 'account_too_new'],
  exactlyOldEnough: [{ ...ELIGIBLE, createdAt: ago(14) }, null],
  tooLow: [{ ...ELIGIBLE, highestHeroLevel: 14 }, 'hero_too_low'],
  noHero: [{ ...ELIGIBLE, highestHeroLevel: 0 }, 'hero_too_low'],
  exactlyLevel15: [{ ...ELIGIBLE, highestHeroLevel: 15 }, null],
  unverified: [{ ...ELIGIBLE, emailVerified: false }, 'email_unverified'],
  muted: [{ ...ELIGIBLE, sanctions: ['mute'] }, 'muted'],
  suspended: [{ ...ELIGIBLE, sanctions: ['suspend'] }, 'suspended'],
  tradeRestricted: [{ ...ELIGIBLE, sanctions: ['trade'] }, 'trade_restricted'],
  renamed: [{ ...ELIGIBLE, sanctions: ['rename'] }, null],
  contentHidden: [{ ...ELIGIBLE, sanctions: ['hide'] }, null],
};

const rel = (over: Partial<TradeRelationFacts>): TradeRelationFacts => ({
  self: false,
  blocked: false,
  friendSince: null,
  guildmatesSince: null,
  ...over,
});

/** Relation → the check it fails. */
const RELATIONS: Record<string, [TradeRelationFacts, TradeCheckId | null]> = {
  stranger: [rel({}), 'no_relation'],
  self: [rel({ self: true }), 'self'],
  friendNew: [rel({ friendSince: ago(7, 1) }), 'relation_too_new'],
  friendExactly7: [rel({ friendSince: ago(7) }), null],
  friendOld: [rel({ friendSince: ago(40) }), null],
  guildmateNew: [rel({ guildmatesSince: ago(2) }), 'relation_too_new'],
  guildmateOld: [rel({ guildmatesSince: ago(8) }), null],
  // An old guild tie makes a fresh friendship old enough, and the other way round.
  newFriendOldGuildmate: [rel({ friendSince: ago(1), guildmatesSince: ago(9) }), null],
  blockedFriend: [rel({ blocked: true, friendSince: ago(40) }), 'blocked'],
  blockedStranger: [rel({ blocked: true }), 'blocked'],
};

/** Switch state → the check it fails. */
const SWITCHES: Record<string, [TradingSettings, TradeCheckId | null]> = {
  closed: [CLOSED, 'trading_off'],
  open: [OPEN, null],
};

/** Actions that check eligibility; the others are always allowed. */
const CHECKED: Record<TradeAction, boolean> = {
  send: true,
  accept: true,
  decline: false,
  cancel: false,
  view: false,
};

describe('tradeDecision: the permission matrix', () => {
  it('covers every action, and stepping away is never refused', () => {
    expect(Object.keys(CHECKED).sort()).toEqual([...TRADE_ACTIONS].sort());
    for (const a of TRADE_ACTIONS) expect(TRADE_ACTION_CHECKS[a].length > 0).toBe(CHECKED[a]);
  });

  it('switches × relation × your standing × action', () => {
    let cases = 0;
    for (const [sw, [settings, swCheck]] of Object.entries(SWITCHES)) {
      for (const [r, [relation, relCheck]] of Object.entries(RELATIONS)) {
        for (const [st, [actor, standCheck]] of Object.entries(STANDINGS)) {
          for (const action of TRADE_ACTIONS) {
            const d = tradeDecision({
              action,
              settings,
              now: NOW,
              actor,
              counterpart: ELIGIBLE,
              relation,
            });
            const expected = CHECKED[action]
              ? [swCheck, relCheck, standCheck].filter((c): c is TradeCheckId => c !== null)
              : [];
            expect(
              d.refusals.map((x) => x.check),
              `${sw} ${r} ${st} ${action}`,
            ).toEqual(expected);
            expect(d.allowed).toBe(expected.length === 0);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(2 * 10 * 12 * 5);
  });

  it('the other account’s standing × action, named for them, never as yours', () => {
    for (const [st, [counterpart, check]] of Object.entries(STANDINGS)) {
      for (const action of TRADE_ACTIONS) {
        const d = tradeDecision({
          action,
          settings: OPEN,
          now: NOW,
          actor: ELIGIBLE,
          counterpart,
          relation: RELATIONS.friendOld![0],
        });
        const expected = CHECKED[action] && check ? [{ check, party: 'them' }] : [];
        expect(d.refusals, `${st} ${action}`).toEqual(expected);
        // Whatever rule they miss, the words read the same.
        for (const r of d.refusals)
          expect(tradeRefusalText(r)).toBe(TRADE_CHECK_TEXT.them_not_eligible);
      }
    }
  });

  it('a hidden counterpart is one bit; null is not evaluated', () => {
    const base = {
      action: 'send' as const,
      settings: OPEN,
      now: NOW,
      actor: ELIGIBLE,
      relation: RELATIONS.friendOld![0],
    };
    expect(tradeDecision({ ...base, counterpart: 'hidden-eligible' }).allowed).toBe(true);
    expect(tradeDecision({ ...base, counterpart: null }).allowed).toBe(true);
    expect(tradeDecision({ ...base, counterpart: 'hidden-ineligible' }).refusals).toEqual([
      { check: 'them_not_eligible', party: 'them' },
    ]);
  });

  it('lists every failure in order, and dates only your own and the pair’s rules', () => {
    const d = tradeDecision({
      action: 'accept',
      settings: CLOSED,
      now: NOW,
      actor: {
        createdAt: ago(1),
        highestHeroLevel: 3,
        emailVerified: false,
        sanctions: ['trade', 'mute'],
      },
      counterpart: { ...ELIGIBLE, createdAt: ago(2) },
      relation: rel({ friendSince: ago(3) }),
    });
    expect(d.refusals.map((r) => `${r.party}:${r.check}`)).toEqual([
      'game:trading_off',
      'pair:relation_too_new',
      'you:account_too_new',
      'you:hero_too_low',
      'you:email_unverified',
      'you:muted',
      'you:trade_restricted',
      'them:account_too_new',
    ]);
    expect(d.refusals.find((r) => r.check === 'relation_too_new')!.metAt).toBe(
      ago(3 - 7).toISOString(),
    );
    expect(d.refusals.find((r) => r.party === 'you' && r.check === 'account_too_new')!.metAt).toBe(
      ago(1 - 14).toISOString(),
    );
    // The other account's creation date is never handed on.
    expect(d.refusals.find((r) => r.party === 'them')!.metAt).toBeUndefined();
  });

  it('every sanction kind has a stated effect on trading', () => {
    expect(Object.keys(TRADE_SANCTION_CHECK).sort()).toEqual([...SANCTION_KINDS].sort());
    const blocking: SanctionKind[] = SANCTION_KINDS.filter((k) => TRADE_SANCTION_CHECK[k]);
    expect(blocking.sort()).toEqual(['mute', 'suspend', 'trade']);
  });

  it('has words for every check and the documented thresholds', () => {
    for (const c of TRADE_CHECKS) expect(TRADE_CHECK_TEXT[c].length).toBeGreaterThan(5);
    expect(TRADE_ELIGIBILITY).toEqual({
      minAccountAgeDays: 14,
      minHeroLevel: 15,
      minRelationAgeDays: 7,
    });
  });

  it('a friend and a guildmate tie: the older one counts', () => {
    expect(tradeRelationKind(rel({ friendSince: ago(1), guildmatesSince: ago(9) }))).toBe(
      'guildmate',
    );
    expect(tradeRelationKind(rel({ friendSince: ago(9), guildmatesSince: ago(1) }))).toBe('friend');
    expect(tradeRelationKind(rel({ blocked: true, friendSince: ago(9) }))).toBe('blocked');
  });
});

// ---- The contents. ---------------------------------------------------------------------------

const fresh = (id: string, over: Partial<TradeItemFacts> = {}): TradeItemFacts => ({
  id,
  rarityId: 'legendary',
  source: 'farming',
  binding: 'equip',
  ...over,
});
const side = (over: Partial<TradeOfferFacts['give']> = {}) => ({
  items: [],
  materials: {},
  gold: 0,
  ...over,
});
const offer = (give = side(), ask = side()): TradeOfferFacts => ({ give, ask });

const contents = (o: TradeOfferFacts, settings = OPEN, action: TradeAction = 'send') =>
  tradeDecision({
    action,
    settings,
    now: NOW,
    actor: ELIGIBLE,
    counterpart: ELIGIBLE,
    relation: RELATIONS.friendOld![0],
    offer: o,
  }).refusals;

describe('tradeDecision: the offer contents', () => {
  it('a gift of a fresh Legendary is fine; nothing at all is not', () => {
    expect(contents(offer(side({ items: [fresh('a')] })))).toEqual([]);
    expect(contents(offer()).map((r) => r.check)).toEqual(['empty_offer']);
  });

  it('each kind needs its switch, on either side', () => {
    const closedGold = settingsWith((s) => {
      s.trading = true;
      s.trade = { items: true, materials: true, gold: false };
    });
    expect(contents(offer(side(), side({ gold: 10 })), closedGold)).toEqual([
      { check: 'kind_off', party: 'offer', side: 'ask', kind: 'gold' },
    ]);
    const closedAll = settingsWith((s) => (s.trading = true));
    expect(
      contents(
        offer(side({ items: [fresh('a')], materials: { timber: 3 }, gold: 1 })),
        closedAll,
      ).map((r) => r.kind),
    ).toEqual(['items', 'materials', 'gold']);
  });

  it('per-offer limits come from the settings', () => {
    const items = Array.from({ length: 7 }, (_, i) => fresh(`i${i}`));
    expect(contents(offer(side({ items }))).map((r) => r.check)).toEqual(['too_many_items']);
    expect(contents(offer(side({ items: items.slice(0, 6) })))).toEqual([]);
    expect(contents(offer(side({ gold: 5_001 }))).map((r) => r.check)).toEqual(['gold_per_offer']);
    expect(contents(offer(side({ gold: 5_000 })))).toEqual([]);
    const tight = settingsWith((s) => {
      s.trading = true;
      s.trade = { items: true, materials: true, gold: true };
      s.limits.goldPerOffer = 100;
      s.limits.itemsPerSide = 1;
    });
    expect(
      contents(offer(side({ gold: 101, items: items.slice(0, 2) })), tight).map((r) => r.check),
    ).toEqual(['too_many_items', 'gold_per_offer']);
  });

  it('refuses negative, fractional and repeated amounts', () => {
    for (const bad of [
      side({ gold: -1 }),
      side({ gold: 1.5 }),
      side({ materials: { timber: -2 } }),
    ]) {
      expect(contents(offer(bad)).map((r) => r.check)).toContain('invalid_amount');
    }
    expect(contents(offer(side({ items: [fresh('a'), fresh('a')] }))).map((r) => r.check)).toEqual([
      'invalid_amount',
    ]);
  });

  it('never seals', () => {
    expect(contents(offer(side({ materials: { gravewardenSeal: 1 } })))).toEqual([
      {
        check: 'material_not_tradeable',
        party: 'offer',
        side: 'give',
        materialId: 'gravewardenSeal',
      },
    ]);
  });

  it('items: binding, category switches, provenance and state', () => {
    const cases: [TradeItemFacts, TradeCheckId[]][] = [
      [fresh('a'), []],
      [fresh('a', { rarityId: 'rare' }), ['item_bound']],
      [fresh('a', { source: 'hoard:crypt' }), ['item_bound']],
      [fresh('a', { source: 'quest' }), ['item_bound']],
      [fresh('a', { upgradeLevel: 1 }), ['item_bound']],
      [fresh('a', { firstEquippedAt: ago(3) }), ['item_bound']],
      [fresh('a', { tradedCount: 1 }), ['item_bound']],
      [fresh('a', { rarityId: 'mythic' }), ['item_category_off']],
      [fresh('a', { variant: 'void' }), ['item_category_off']],
      [fresh('a', { unprovenanced: true }), ['item_unprovenanced']],
      [fresh('a', { locked: true }), ['item_locked']],
      [fresh('a', { inWarehouse: true }), ['item_stored']],
      [fresh('a', { onShelf: true }), ['item_on_shelf']],
      [fresh('a', { holdUntil: new Date(NOW.getTime() + 1) }), ['item_held']],
      [fresh('a', { holdUntil: NOW }), []],
    ];
    for (const [item, expected] of cases) {
      const got = contents(offer(side(), side({ items: [item] })));
      expect(
        got.map((r) => r.check),
        JSON.stringify(item),
      ).toEqual(expected);
      for (const r of got) expect(r).toMatchObject({ itemId: 'a', side: 'ask' });
    }
    expect(
      contents(offer(side({ items: [fresh('a', { unprovenanced: true })] })))[0],
    ).toMatchObject({
      flag: true,
    });
    expect(
      contents(offer(side({ items: [fresh('a', { rarityId: 'mythic', variant: 'void' })] })))[0],
    ).toMatchObject({
      categories: ['mythic', 'void'],
    });
  });

  it('contents are not checked for cancel, decline or view', () => {
    for (const a of ['cancel', 'decline', 'view'] as const) {
      expect(contents(offer(side({ gold: -5 })), CLOSED, a)).toEqual([]);
    }
  });
});
