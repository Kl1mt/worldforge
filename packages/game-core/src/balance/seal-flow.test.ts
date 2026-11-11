/**
 * Ticket 6.11: the Seal and Abbey silver sinks don't starve awakening (docs/BALANCE.md "6.11").
 * Rates are measured as B.5 item 8 (`tools/balance/awakening.ts time`, `endgame.ts sinks`): Verge
 * Legendaries +10 at 38, five tries a day at the Tyrant's and the crypt's hoards, fixed seeds; the
 * season is game-core's `sealFlow` (expected values, a day at a time).
 */
import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  COSMETIC_EXCHANGE,
  DEFAULT_AWAKENING_SETTINGS,
  ENGRAVING_PRICES,
  simulateDungeonRun,
  type ClassId,
  type DungeonId,
  type DungeonTier,
} from '../index.js';
import { buildSlots } from './builds.js';
import { legendaryKit, upgraded } from './kits.js';
import { sealFlow, type SealFlowPrices } from './seal-flow.js';

const SLOW = { timeout: 120_000 };
const k = DEFAULT_AWAKENING_SETTINGS.cost;
const PRICES: SealFlowPrices = {
  awakenSeals: k.gravewardenSeal,
  awakenEmbers: k.tyrantsEmber,
  exchange: COSMETIC_EXCHANGE.map((o) => ({
    seals: o.price.gravewardenSeal ?? 0,
    silver: o.price.abbeySilver ?? 0,
  })),
  engraveSeals: ENGRAVING_PRICES.seal.gravewardenSeal!,
  engraveSilver: ENGRAVING_PRICES.silver.abbeySilver!,
};

function rates(c: ClassId) {
  const items = upgraded(legendaryKit(c, 33), 10);
  const win = (dungeonId: DungeonId, tier: DungeonTier) => {
    let w = 0;
    const n = 40;
    for (let i = 0; i < n; i++) {
      const r = simulateDungeonRun({
        dungeonId,
        tier,
        character: { classId: c, level: 38, xp: 0 },
        equipment: items,
        seed: `awakening-time:${dungeonId}:${i}`,
        bossLootEligible: false,
        inventoryCount: 0,
      });
      if (r.bossDefeated) w++;
    }
    return w / n;
  };
  const perDay = (p: number) => 1 - (1 - p) ** 5;
  return {
    embersPerDay: perDay(win('tyrantsForge', 1)),
    sealsPerDay: perDay(Math.max(win('namelessCrypt', 4), win('namelessCrypt', 3))),
  };
}

describe('ticket 6.11: the Seal and silver flow of a dedicated player’s season', () => {
  it.each(CLASS_IDS)(
    '%s: the sinks leave the awakened kit’s day as it was and spend the spare Seals',
    SLOW,
    (c) => {
      const base = {
        days: 56,
        guildSealsPerWeek: 2,
        pieces: buildSlots(c).length,
        silverStock: 150,
        prices: PRICES,
        ...rates(c),
      };
      const before = sealFlow({ ...base, sinks: false });
      const after = sealFlow({ ...base, sinks: true });
      // B.5's band: a whole kit in 24–27 days (about one season), 15–17 spare Seals at the end.
      expect(before.kitDay, c).not.toBeNull();
      expect(before.kitDay!, c).toBeGreaterThanOrEqual(24);
      expect(before.kitDay!, c).toBeLessThanOrEqual(27);
      expect(before.spareAtKit!, c).toBeGreaterThan(14);
      expect(before.spareAtKit!, c).toBeLessThan(18);
      // The sinks spend only the Seals above the reserve: the kit lands on the same day.
      expect(after.kitDay, c).toBe(before.kitDay);
      expect(after.sealsToAwakening, c).toBe(before.sealsToAwakening);
      // … and take most of what was spare by then (≤ 5 left), and Abbey silver gets spent.
      expect(after.spareAtKit!, c).toBeLessThanOrEqual(5);
      expect(after.sinkSealsAtKit!, c).toBeGreaterThanOrEqual(11);
      expect(after.silverToSinks, c).toBeGreaterThanOrEqual(75);
      expect(after.engravings, c).toBe(base.pieces);
      // Holdings never go negative.
      expect(after.sealsLeft, c).toBeGreaterThanOrEqual(0);
      expect(after.silverLeft, c).toBeGreaterThanOrEqual(0);
    },
  );

  it('a sink-first player who ignores the reserve is the only way to slow awakening', () => {
    // With no Seals spare (the reserve is everything), the model buys nothing with Seals.
    const r = sealFlow({
      days: 10,
      sealsPerDay: 0.5,
      guildSealsPerWeek: 0,
      embersPerDay: 1,
      pieces: 8,
      silverStock: 0,
      prices: PRICES,
      sinks: true,
    });
    expect(r.sealsToSinks).toBe(0);
    expect(r.silverToSinks).toBe(0);
  });
});
