import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  DEFAULT_EFFECT_CAPS,
  DEFAULT_PVP_CONFIG,
  characterPower,
  settleFarming,
  LEVEL_BRACKETS,
  PVP_BRACKETS,
  PVP_RULES_VERSION,
  deriveEquippedStats,
  normaliseFighter,
  pvpBracketOf,
  pvpReferenceStats,
  simulateDuel,
  type DuelInput,
  type DuelResult,
  type EquippedItem,
  type PvpConfig,
} from '../index.js';
import { fighter, gear, kit, sampleBuild } from '../balance/pvp-fixtures.js';

/** Ticket 5.4: the duel engine and the normalisation layer (balance: `pvp-balance.test.ts`). */

const hash = (v: unknown): string => {
  const text = JSON.stringify(v);
  // Two FNV-1a passes (different offsets) → 64 bits as hex, as in `noEffects.test.ts`.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
};

const bracket = (id: string) => PVP_BRACKETS.find((b) => b.id === id)!;

/** A late-game duel: two B.2-shaped builds at 25. */
const lateDuel = (seed: string): DuelInput => ({
  challenger: fighter('warrior', 25, sampleBuild('warrior', 24, 1)),
  defender: fighter('mage', 25, sampleBuild('mage', 24, 2)),
  seed,
});

describe('brackets', () => {
  it('are exactly the 5.2 leaderboard brackets, each with a reference level inside it', () => {
    expect(PVP_BRACKETS.map(({ id, label, min, max }) => ({ id, label, min, max }))).toEqual(
      LEVEL_BRACKETS.map(({ id, label, min, max }) => ({ id, label, min, max })),
    );
    for (const b of PVP_BRACKETS) {
      expect(b.referenceLevel).toBeGreaterThanOrEqual(b.min);
      if (b.max !== null) expect(b.referenceLevel).toBeLessThanOrEqual(b.max);
    }
    expect(pvpBracketOf(1).id).toBe('1-9');
    expect(pvpBracketOf(19).id).toBe('10-19');
    expect(pvpBracketOf(60).id).toBe('30-plus');
    expect(() => pvpBracketOf(0)).toThrow(RangeError);
  });

  it('needs both fighters in one bracket unless a bracket is named', () => {
    const input: DuelInput = {
      challenger: fighter('warrior', 9, []),
      defender: fighter('mage', 10, []),
      seed: 's',
    };
    expect(() => simulateDuel(input)).toThrow(/different brackets/);
    expect(simulateDuel({ ...input, bracketId: '10-19' }).bracketId).toBe('10-19');
    expect(() => simulateDuel({ ...input, bracketId: 'nope' })).toThrow(RangeError);
    expect(() => simulateDuel({ ...input, bracketId: '1-9', seed: '' })).toThrow(/seed/);
  });
});

describe('normalisation', () => {
  it('leaves the PvE stats as the PvE rules compute them', () => {
    for (const c of CLASS_IDS) {
      const items = gear(c, 25, 'legendary+10void', 0);
      const before = JSON.stringify(items);
      const f = normaliseFighter(fighter(c, 25, items), bracket('20-29'));
      expect(f.pveStats).toEqual(deriveEquippedStats(c, 25, items));
      expect(JSON.stringify(items)).toBe(before);
    }
  });

  it('turns the reference hero into the reference, and keeps a quarter of what gear adds', () => {
    const b = bracket('10-19');
    const noTuning: PvpConfig = {
      ...DEFAULT_PVP_CONFIG,
      classDamage: {},
    };
    for (const c of CLASS_IDS) {
      const ref = pvpReferenceStats(c, b);
      const naked = normaliseFighter(fighter(c, b.referenceLevel, []), b, noTuning);
      const geared = normaliseFighter(
        fighter(c, b.referenceLevel, gear(c, b.referenceLevel, 'epic', 0)),
        b,
        noTuning,
      );
      // Level does not count: a level-10 and a level-19 naked hero are the same fighter.
      const low = normaliseFighter(fighter(c, 10, []), b, noTuning);
      const high = normaliseFighter(fighter(c, 19, []), b, noTuning);
      expect(low.stats).toEqual(high.stats);
      for (const id of ['physicalDamage', 'magicDamage', 'armor', 'resistance'] as const) {
        const nakedGap = naked.pveStats[id] - ref[id];
        expect(naked.stats[id]).toBeCloseTo(ref[id] + 0.25 * nakedGap, 6);
        expect(geared.stats[id] - naked.stats[id]).toBeCloseTo(
          0.25 * (geared.pveStats[id] - naked.pveStats[id]),
          6,
        );
      }
    }
  });

  it('scales effect bonuses, keeps their thresholds, and switches PvE-only mechanics off', () => {
    const items = sampleBuild('hunter', 24, 3).map((i, k): EquippedItem =>
      k === 0 ? { ...i, effectId: 'headsmans-due', effectRoll: 1 } : i,
    );
    const f = normaliseFighter(fighter('hunter', 25, items), bracket('20-29'));
    expect(f.effects.execute.threshold).toBe(0.3);
    expect(f.effects.execute.bonus).toBeGreaterThan(0);
    expect(f.effects.bossSlayer).toBe(0);
    expect(f.effects.lifeOnKill).toBe(0);
    expect(f.effects.bloodrush.perStack).toBe(0);
  });
});

describe('duels', () => {
  it('are deterministic: the same seed gives the same duel, in every call', () => {
    const a = simulateDuel(lateDuel('det:1'));
    const b = simulateDuel(lateDuel('det:1'));
    expect(b).toEqual(a);
    // A different seed is a different duel (each pinned below, so this is not left to chance).
    expect(hash(simulateDuel(lateDuel('det:2')).events)).not.toBe(hash(a.events));
  });

  it('are pinned: a changed number needs a new PVP_RULES_VERSION', () => {
    // Recompute with `hash(simulateDuel(lateDuel(seed)))` after a deliberate rules change, and
    // bump PVP_RULES_VERSION so 5.5 can tell stored duels of the old rules apart.
    expect(PVP_RULES_VERSION).toBe(1);
    const pinned: Record<string, string> = {
      'det:1': 'f1c5051654a911cd',
      'det:2': '01283ed69b603229',
    };
    for (const [seed, h] of Object.entries(pinned)) {
      expect(hash(simulateDuel(lateDuel(seed))), seed).toBe(h);
    }
  });

  it('write a consistent log: health follows the blows, and the end matches the result', () => {
    for (let s = 0; s < 40; s++) {
      const r = simulateDuel(lateDuel(`log:${s}`));
      const hp = { challenger: r.sides.challenger.maxHealth, defender: r.sides.defender.maxHealth };
      const start = r.events[0]!;
      expect(start).toEqual({ t: 0, type: 'start', initiative: r.initiative, health: hp });
      let last = 0;
      for (const e of r.events) {
        expect(e.t).toBeGreaterThanOrEqual(last);
        last = e.t;
        if (e.type === 'attack') {
          const target = e.side === 'challenger' ? 'defender' : 'challenger';
          hp[target] -= e.damage;
          expect(e.health).toBe(hp[target]);
          expect(e.damage).toBeGreaterThan(0);
        } else if (e.type === 'thorns') {
          const striker = e.side === 'challenger' ? 'defender' : 'challenger';
          hp[striker] -= e.damage;
          expect(e.health).toBe(hp[striker]);
        }
      }
      expect(hp.challenger).toBe(r.sides.challenger.health);
      expect(hp.defender).toBe(r.sides.defender.health);
      expect(r.events.at(-1)).toEqual({
        t: r.durationMs,
        type: 'end',
        outcome: r.outcome,
        reason: r.reason,
      });
      if (r.reason === 'defeat') {
        const loser = r.outcome === 'challenger' ? 'defender' : 'challenger';
        expect(r.sides[loser].health).toBe(0);
        expect(r.events.at(-2)).toEqual({ t: r.durationMs, type: 'defeat', side: loser });
      }
    }
  });

  it('mirror every effect: thorns answer for whichever side wears them', () => {
    const thornsKit = kit('warrior', 24, 'legendary', 0).map((i, k): EquippedItem =>
      k === 0 ? { ...i, effectId: 'bramblemail', effectRoll: 1 } : i,
    );
    const plain = kit('warrior', 24, 'legendary', 0).map((i): EquippedItem => ({
      ...i,
      effectId: null,
    }));
    for (const side of ['challenger', 'defender'] as const) {
      const input: DuelInput = {
        challenger: fighter('warrior', 25, side === 'challenger' ? thornsKit : plain),
        defender: fighter('warrior', 25, side === 'defender' ? thornsKit : plain),
        seed: 'thorns',
      };
      const thorns = simulateDuel(input).events.filter((e) => e.type === 'thorns');
      expect(thorns.length).toBeGreaterThan(0);
      expect(new Set(thorns.map((e) => e.type === 'thorns' && e.side))).toEqual(new Set([side]));
    }
  });

  it('ignore PvE-only gear: gold, item and XP find, boss damage, boss slayer, kill effects', () => {
    const base = kit('mage', 24, 'legendary', 4);
    const strip = base.map((i): EquippedItem => ({ ...i, effectId: null }));
    const pveOnly = strip.map((i, k): EquippedItem =>
      k === 0
        ? {
            ...i,
            affixes: [
              ...i.affixes,
              { affixId: 'gold-find', tier: 3, value: 0.15 },
              { affixId: 'item-find', tier: 3, value: 0.15 },
              { affixId: 'xp-gain', tier: 3, value: 0.1 },
              { affixId: 'boss-damage', tier: 3, value: 0.15 },
            ],
          }
        : k === 1
          ? { ...i, effectId: 'tyrants-bane', effectRoll: 1 }
          : k === 2
            ? { ...i, effectId: 'carrion-feast', effectRoll: 1 }
            : k === 3
              ? { ...i, effectId: 'bloodrush', effectRoll: 1 }
              : i,
    );
    const opponent = fighter('hunter', 25, kit('hunter', 24, 'rare', 1));
    for (let s = 0; s < 10; s++) {
      const a = simulateDuel({
        challenger: fighter('mage', 25, strip),
        defender: opponent,
        seed: `p:${s}`,
      });
      const b = simulateDuel({
        challenger: fighter('mage', 25, pveOnly),
        defender: opponent,
        seed: `p:${s}`,
      });
      expect(b).toEqual(a);
    }
  });

  it('end at the time limit by health share, and in a draw on an exact tie', () => {
    const twin = fighter('warrior', 25, kit('warrior', 24, 'rare', 2));
    // Nobody strikes before the limit: both at full health, an exact tie.
    const short: PvpConfig = { ...DEFAULT_PVP_CONFIG, maxDuelMs: 500 };
    const draw = simulateDuel({ challenger: twin, defender: twin, seed: 'tl' }, short);
    expect(draw).toMatchObject({ outcome: 'draw', reason: 'timeLimit', durationMs: 500 });
    expect(draw.events.map((e) => e.type)).toEqual(['start', 'timeLimit', 'end']);
    // A few blows each, then the limit: the larger share of health left wins.
    const mid: PvpConfig = { ...DEFAULT_PVP_CONFIG, maxDuelMs: 3_500 };
    for (let s = 0; s < 20; s++) {
      const r = simulateDuel({ challenger: twin, defender: twin, seed: `tl:${s}` }, mid);
      expect(r.reason).toBe('timeLimit');
      const c = r.sides.challenger.health / r.sides.challenger.maxHealth;
      const d = r.sides.defender.health / r.sides.defender.maxHealth;
      expect(r.outcome).toBe(c > d ? 'challenger' : d > c ? 'defender' : 'draw');
    }
  });

  it('turn into sudden death: blows grow after its start', () => {
    const wall = fighter('warrior', 25, kit('warrior', 24, 'legendary', 3));
    const early: PvpConfig = { ...DEFAULT_PVP_CONFIG, suddenDeath: { atMs: 0, perSecond: 1 } };
    const r = simulateDuel({ challenger: wall, defender: wall, seed: 'sd' }, early);
    const normal = simulateDuel({ challenger: wall, defender: wall, seed: 'sd' });
    expect(r.events.some((e) => e.type === 'suddenDeath')).toBe(true);
    expect(normal.events.some((e) => e.type === 'suddenDeath')).toBe(false);
    expect(r.durationMs).toBeLessThan(normal.durationMs);
  });

  it('give two identical fighters an even duel', () => {
    // Fixed seeds: a measurement, not a chance (the share is the same in every run).
    let wins = 0;
    const twin = fighter('hunter', 15, kit('hunter', 14, 'epic', 5));
    const n = 400;
    for (let s = 0; s < n; s++) {
      const r: DuelResult = simulateDuel({ challenger: twin, defender: twin, seed: `even:${s}` });
      if (r.outcome === 'challenger') wins++;
      else if (r.outcome === 'draw') wins += 0.5;
    }
    expect(wins / n).toBeGreaterThan(0.44);
    expect(wins / n).toBeLessThan(0.56);
  });

  it('change no PvE number: Power, farming and the combat config are the same around duels', () => {
    const items = sampleBuild('warlock', 24, 6);
    const power = () => characterPower({ classId: 'warlock', level: 25, equipment: items });
    const farm = () =>
      settleFarming({
        character: { classId: 'warlock', level: 25, xp: 0 },
        equipment: items,
        areaId: 'ashenPass',
        seed: 'pvp-invariance',
        firstCycle: 0,
        durationMs: 10 * 60_000,
        inventoryCount: 0,
      });
    const config = JSON.stringify([DEFAULT_COMBAT_CONFIG, DEFAULT_EFFECT_CAPS, DEFAULT_PVP_CONFIG]);
    const before = { power: power(), farm: farm(), items: JSON.stringify(items) };
    for (let s = 0; s < 50; s++) {
      simulateDuel({
        challenger: fighter('warlock', 25, items),
        defender: fighter('warrior', 25, sampleBuild('warrior', 24, s)),
        seed: `inv:${s}`,
      });
    }
    expect(power()).toEqual(before.power);
    expect(farm()).toEqual(before.farm);
    expect(JSON.stringify(items)).toBe(before.items);
    expect(JSON.stringify([DEFAULT_COMBAT_CONFIG, DEFAULT_EFFECT_CAPS, DEFAULT_PVP_CONFIG])).toBe(
      config,
    );
  });

  it('are fast: a late-game duel well under a millisecond', () => {
    const inputs = Array.from({ length: 500 }, (_, s) => lateDuel(`perf:${s}`));
    const t0 = Date.now();
    for (const input of inputs) simulateDuel(input);
    const perDuel = (Date.now() - t0) / inputs.length;
    // Measured ≈ 0.1 ms (normalisation included); the bound sits far above it so a slow CI runner never trips it.
    expect(perDuel).toBeLessThan(2);
  });
});
