import type { ClassId } from '../classes.js';
import type { EffectInstance } from '../effects/types.js';
import { awakenedEffectStrength, type ItemAwakening } from './awakening-state.js';
import { canClassUseItem, getItemBase } from './bases.js';

/**
 * Set items (ticket 3.3, GDD §7.4): a late-game layer of named items with fixed bases. Wearing
 * several pieces of one set activates its bonuses, which are `kind: 'set'` entries of the effect
 * registry, passed to combat as `equipmentModifiers(…, { extraEffects: setBonusInstances(…) })`.
 *
 * A set piece is a Legendary-rarity item (its affixes roll like a Legendary's) with a fixed base
 * and the `set_id` column, but no effect of its own: its power is the set bonus. Pieces drop where
 * a loot table sets `setShare` (the Sunken Abbey, the Nameless Crypt and the Gravewarden's hoard):
 * that share of Legendary rolls there becomes a set piece instead.
 */
export interface SetBonusDefinition {
  /** Distinct pieces worn to activate it. */
  pieces: number;
  /** A `kind: 'set'` effect of the registry. */
  effectId: string;
}

export interface SetDefinition {
  id: string;
  name: string;
  /** One-line flavour of the set's play pattern. */
  theme: string;
  /** Base ids of the pieces; each is a `unique` base that only this set drops. */
  pieces: readonly string[];
  /** In ascending piece count. */
  bonuses: readonly SetBonusDefinition[];
}

export const ITEM_SETS: readonly SetDefinition[] = [
  {
    id: 'drowned-vigil',
    name: 'The Drowned Vigil',
    theme: 'Martial: stand in the tide, let them break on you, then finish them.',
    pieces: [
      'vigil-helm',
      'vigil-hauberk',
      'vigil-gauntlets',
      'vigil-sabatons',
      'vigil-oath-chain',
      'vigil-seal',
    ],
    bonuses: [
      { pieces: 2, effectId: 'vigil-tidebound' },
      { pieces: 4, effectId: 'vigil-hold-the-line' },
      { pieces: 6, effectId: 'vigil-undertow' },
    ],
  },
  {
    id: 'ashen-choir',
    name: 'The Ashen Choir',
    theme: 'Arcane: crits kindle fire and call the class skill; the last hymn is for the great.',
    pieces: [
      'choir-cowl',
      'choir-vestments',
      'choir-wraps',
      'choir-slippers',
      'choir-censer-chain',
      'choir-band',
    ],
    bonuses: [
      { pieces: 2, effectId: 'choir-kindled' },
      { pieces: 4, effectId: 'choir-hymn-of-cinders' },
      { pieces: 6, effectId: 'choir-last-rite' },
    ],
  },
  {
    id: 'bloodmoon-hunt',
    name: 'The Bloodmoon Hunt',
    theme: 'Hybrid: chain kills, open every fight with the class skill, feed on the fallen.',
    pieces: ['bloodmoon-grips', 'bloodmoon-treads', 'bloodmoon-fang', 'bloodmoon-loop'],
    bonuses: [
      { pieces: 2, effectId: 'bloodmoon-scent' },
      { pieces: 4, effectId: 'bloodmoon-long-hunt' },
    ],
  },
];

const SETS_BY_ID = new Map(ITEM_SETS.map((s) => [s.id, s]));
const SETS_BY_BASE = new Map(ITEM_SETS.flatMap((s) => s.pieces.map((p) => [p, s] as const)));

export function findSet(id: string): SetDefinition | undefined {
  return SETS_BY_ID.get(id);
}

/** The set whose piece this base is, if any. */
export function setForBase(baseId: string): SetDefinition | undefined {
  return SETS_BY_BASE.get(baseId);
}

/**
 * Set pieces that can drop at an item level, for a class (only pieces it can use) or, without a
 * class, all of them.
 */
export function setPiecePool(itemLevel: number, classId?: ClassId): string[] {
  return ITEM_SETS.flatMap((s) => s.pieces).filter((id) => {
    const base = getItemBase(id);
    return (
      base.minItemLevel <= itemLevel && (classId === undefined || canClassUseItem(base, classId))
    );
  });
}

/** Item fields set counting reads. `variant` is deliberately not one of them. */
export interface SetCarrier {
  baseId: string;
  setId?: string | null;
  /** Ticket 6.5 prototype (off; no stored item carries it): see `setBonusInstances`. */
  awakening?: ItemAwakening | null;
}

/** A set as worn: distinct pieces equipped and the bonuses they activate. */
export interface WornSet {
  set: SetDefinition;
  /** Distinct piece base ids worn, in the set's order. */
  pieces: string[];
  /** Bonuses with `pieces` ≤ the count. */
  active: SetBonusDefinition[];
}

/**
 * Counts set pieces among equipped items. A piece counts when its `setId` names a set and its base
 * is one of that set's pieces; each piece counts once (two copies of one ring are one piece).
 * The variant is never read: a Void piece is the same piece (GDD §7.4). Sets with no piece worn
 * are left out.
 */
export function wornSets(items: readonly SetCarrier[]): WornSet[] {
  const worn = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.setId) continue;
    const set = SETS_BY_ID.get(item.setId);
    if (!set || !set.pieces.includes(item.baseId)) continue;
    let pieces = worn.get(set.id);
    if (!pieces) worn.set(set.id, (pieces = new Set()));
    pieces.add(item.baseId);
  }
  return ITEM_SETS.filter((s) => worn.has(s.id)).map((set) => {
    const ids = worn.get(set.id)!;
    return {
      set,
      pieces: set.pieces.filter((p) => ids.has(p)),
      active: set.bonuses.filter((b) => b.pieces <= ids.size),
    };
  });
}

/**
 * The effect instances of the active set bonuses (fixed roll), for
 * `equipmentModifiers(…, { extraEffects })`. Empty without two pieces of one set.
 */
export function setBonusInstances(items: readonly SetCarrier[]): EffectInstance[] {
  return wornSets(items).flatMap((w) => {
    const strengths = awakenedPieceStrengths(items, w);
    return w.active.map((b) => {
      // Ticket 6.5 prototype (off): a bonus of n pieces is awakened when n distinct worn pieces
      // are; without an awakened piece the instance is exactly the pre-6.5 one.
      const strength = strengths[b.pieces - 1] ?? 1;
      return strength > 1
        ? { effectId: b.effectId, roll: 1, strength }
        : { effectId: b.effectId, roll: 1 };
    });
  });
}

/**
 * Ticket 6.5 prototype: the effect awakening of each distinct worn piece of a set (the strongest
 * copy of a piece), strongest first. Empty when no piece is awakened, the case of every item today.
 */
function awakenedPieceStrengths(items: readonly SetCarrier[], worn: WornSet): number[] {
  const byPiece = new Map<string, number>();
  for (const item of items) {
    if (!item.awakening || item.setId !== worn.set.id || !worn.pieces.includes(item.baseId)) {
      continue;
    }
    const s = awakenedEffectStrength(item);
    if (s > (byPiece.get(item.baseId) ?? 1)) byPiece.set(item.baseId, s);
  }
  return [...byPiece.values()].sort((a, b) => b - a);
}
