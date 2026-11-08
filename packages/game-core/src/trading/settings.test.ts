import { describe, expect, it } from 'vitest';
import { DEFAULT_TRADING_SWITCHES, TRADE_CATEGORIES, itemBinding } from './binding.js';
import {
  DEFAULT_TRADING_SETTINGS,
  TRADING_LIMITS,
  TRADING_LIMIT_IDS,
  TRADING_SWITCHES,
  TRADING_SWITCH_PATHS,
  diffTradingSettings,
  normaliseTradingSettings,
  readSwitch,
  switchedOff,
  tradingSwitchesOf,
  validateTradingSettings,
  type TradingSettings,
} from './settings.js';

const clone = (s: Readonly<TradingSettings>): TradingSettings =>
  JSON.parse(JSON.stringify(s)) as TradingSettings;

describe('trading settings defaults (docs/TRADING.md "Admin switches")', () => {
  it('match the switch table exactly', () => {
    expect(DEFAULT_TRADING_SETTINGS).toEqual({
      trading: false,
      trade: { items: false, materials: false, gold: false },
      tradeable: { epic: true, legendary: true, set: true, mythic: false, void: false },
      shelf: { items: false, materials: false, gold: false },
      limits: {
        openOffersSent: 3,
        openOffersReceived: 10,
        itemsPerSide: 6,
        tradesPerDay: 5,
        legendarySetPerWeek: 3,
        mythicVoidPerWeek: 1,
        epicPerWeek: 10,
        goldPerOffer: 5_000,
        goldPerWeek: 10_000,
        commonMaterialsPerWeek: 300,
        soulShardsPerWeek: 40,
        abbeySilverPerWeek: 10,
      },
    });
    expect(Object.isFrozen(DEFAULT_TRADING_SETTINGS.limits)).toBe(true);
  });

  it('have the hard maxima of "Per-account limits", each at or above its default', () => {
    expect(Object.fromEntries(TRADING_LIMIT_IDS.map((id) => [id, TRADING_LIMITS[id].max]))).toEqual(
      {
        openOffersSent: 10,
        openOffersReceived: 30,
        itemsPerSide: 12,
        tradesPerDay: 20,
        legendarySetPerWeek: 10,
        mythicVoidPerWeek: 3,
        epicPerWeek: 30,
        goldPerOffer: 25_000,
        goldPerWeek: 50_000,
        commonMaterialsPerWeek: 1_500,
        soulShardsPerWeek: 200,
        abbeySilverPerWeek: 50,
      },
    );
    for (const id of TRADING_LIMIT_IDS) {
      expect(TRADING_LIMITS[id].default).toBeLessThanOrEqual(TRADING_LIMITS[id].max);
    }
  });

  it('agree with T.1 binding switches, so nothing is tradeable at launch', () => {
    expect(tradingSwitchesOf(DEFAULT_TRADING_SETTINGS)).toEqual(DEFAULT_TRADING_SWITCHES);
  });

  it('explain every switch in plain words', () => {
    for (const p of TRADING_SWITCH_PATHS) {
      expect(TRADING_SWITCHES[p].label.length).toBeGreaterThan(0);
      expect(TRADING_SWITCHES[p].whenOff.length).toBeGreaterThan(10);
    }
    expect(TRADING_SWITCH_PATHS).toHaveLength(12);
  });
});

describe('validateTradingSettings: refuses, never clamps', () => {
  it('accepts the defaults and a fully opened set at the maxima', () => {
    expect(validateTradingSettings(clone(DEFAULT_TRADING_SETTINGS))).toEqual({
      ok: true,
      value: DEFAULT_TRADING_SETTINGS,
    });
    const max = clone(DEFAULT_TRADING_SETTINGS);
    for (const id of TRADING_LIMIT_IDS) max.limits[id] = TRADING_LIMITS[id].max;
    expect(validateTradingSettings(max)).toEqual({ ok: true, value: max });
    const zero = clone(DEFAULT_TRADING_SETTINGS);
    for (const id of TRADING_LIMIT_IDS) zero.limits[id] = 0;
    expect(validateTradingSettings(zero).ok).toBe(true);
  });

  it('refuses one over every hard maximum, negatives, fractions and non-numbers', () => {
    for (const id of TRADING_LIMIT_IDS) {
      for (const bad of [
        TRADING_LIMITS[id].max + 1,
        -1,
        1.5,
        '5',
        null,
        Number.POSITIVE_INFINITY,
      ]) {
        const s = clone(DEFAULT_TRADING_SETTINGS) as unknown as { limits: Record<string, unknown> };
        s.limits[id] = bad;
        const r = validateTradingSettings(s);
        expect(r.ok, `${id}=${String(bad)}`).toBe(false);
        if (!r.ok) expect(Object.keys(r.fields)).toEqual([`limits.${id}`]);
      }
    }
    const typo = clone(DEFAULT_TRADING_SETTINGS);
    typo.limits.goldPerWeek = 100_000;
    const r = validateTradingSettings(typo);
    expect(r).toEqual({
      ok: false,
      fields: { 'limits.goldPerWeek': 'The hard maximum is 50,000.' },
    });
  });

  it('refuses missing, extra and non-boolean switches', () => {
    const s = clone(DEFAULT_TRADING_SETTINGS) as unknown as Record<string, Record<string, unknown>>;
    s.trade!.items = 'yes';
    s.tradeable!.common = true;
    delete s.shelf;
    s.extra = {};
    const r = validateTradingSettings(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fields).sort()).toEqual(
        ['extra', 'shelf', 'trade.items', 'tradeable.common'].sort(),
      );
    }
    expect(validateTradingSettings(null).ok).toBe(false);
    expect(validateTradingSettings([]).ok).toBe(false);
  });
});

describe('normaliseTradingSettings: clamps stored values, falls back to defaults', () => {
  it('turns nothing into the defaults (missing keys need no backfill)', () => {
    for (const raw of [undefined, null, {}, [], 'x', 42]) {
      expect(normaliseTradingSettings(raw)).toEqual(DEFAULT_TRADING_SETTINGS);
    }
  });

  it('clamps out-of-range numbers and keeps the valid fields', () => {
    const out = normaliseTradingSettings({
      trading: true,
      trade: { items: true, gold: 'on' },
      limits: { goldPerWeek: 9_999_999, epicPerWeek: -5, tradesPerDay: 7.9, itemsPerSide: 'x' },
      unknown: true,
    });
    expect(out.trading).toBe(true);
    expect(out.trade).toEqual({ items: true, materials: false, gold: false });
    expect(out.limits.goldPerWeek).toBe(50_000);
    expect(out.limits.epicPerWeek).toBe(0);
    expect(out.limits.tradesPerDay).toBe(7);
    expect(out.limits.itemsPerSide).toBe(6);
    expect(out).not.toHaveProperty('unknown');
  });
});

describe('diff and switch-off seam', () => {
  it('lists changed fields and switches turned off', () => {
    const after = clone(DEFAULT_TRADING_SETTINGS);
    after.trading = true;
    after.tradeable.epic = false;
    after.limits.goldPerWeek = 20_000;
    expect(diffTradingSettings(DEFAULT_TRADING_SETTINGS, after)).toEqual([
      { path: 'trading', old: false, new: true },
      { path: 'tradeable.epic', old: true, new: false },
      { path: 'limits.goldPerWeek', old: 10_000, new: 20_000 },
    ]);
    expect(switchedOff(DEFAULT_TRADING_SETTINGS, after)).toEqual(['tradeable.epic']);
    expect(switchedOff(after, DEFAULT_TRADING_SETTINGS)).toEqual(['trading']);
    expect(diffTradingSettings(after, after)).toEqual([]);
  });

  it('reads every switch path', () => {
    for (const p of TRADING_SWITCH_PATHS) {
      expect(typeof readSwitch(DEFAULT_TRADING_SETTINGS, p)).toBe('boolean');
    }
  });
});

describe('tradeable flips only when master + items + category are all on', () => {
  const epic = { rarityId: 'epic' as const, source: 'farming' };
  const voidMythic = { rarityId: 'mythic' as const, variant: 'void' as const, source: 'farming' };

  it('for every combination of the three switches', () => {
    for (const trading of [false, true]) {
      for (const items of [false, true]) {
        for (const cat of [false, true]) {
          const s = clone(DEFAULT_TRADING_SETTINGS);
          s.trading = trading;
          s.trade.items = items;
          s.tradeable.epic = cat;
          // Unrelated switches all on: they must not open anything.
          s.trade.materials = s.trade.gold = true;
          s.shelf.items = s.shelf.materials = s.shelf.gold = true;
          expect(itemBinding(epic, tradingSwitchesOf(s)).tradeable).toBe(trading && items && cat);
        }
      }
    }
  });

  it('a Void Mythic needs both its categories', () => {
    const s = clone(DEFAULT_TRADING_SETTINGS);
    s.trading = s.trade.items = true;
    for (const c of TRADE_CATEGORIES) s.tradeable[c] = false;
    s.tradeable.mythic = true;
    expect(itemBinding(voidMythic, tradingSwitchesOf(s)).tradeable).toBe(false);
    s.tradeable.void = true;
    expect(itemBinding(voidMythic, tradingSwitchesOf(s)).tradeable).toBe(true);
  });
});
