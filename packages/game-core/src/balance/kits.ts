import { CLASS_IDS, type ClassId } from '../classes.js';
import { ITEM_BASES, canClassUseItem } from '../items/bases.js';
import { generateItem, type GeneratedItem } from '../loot/generate.js';
import type { RarityId } from '../rarity.js';
import { createRng } from '../rng.js';

/**
 * Ticket 6.3: the generated kits of `balance.test.ts` (B.1's "kit": one item per droppable slot,
 * the best bases the class can use), shared with the Heroic and modifier suites and
 * `tools/balance/heroic.ts`. Same seeds and order as there, so the kits are the same items.
 */
export function kit(
  classId: ClassId,
  itemLevel: number,
  rarityId: RarityId = 'common',
): GeneratedItem[] {
  const level = Math.max(1, itemLevel);
  const rng = createRng(`kit:${classId}:${level}:${rarityId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: GeneratedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      out.push(
        generateItem({ seed: rng.int(0, 2 ** 31), itemLevel: level, baseId: base.id, rarityId })!,
      );
    }
  }
  return out;
}

/** Every kit slot as a Legendary with an effect rolled for the class. */
export function legendaryKit(c: ClassId, itemLevel: number): GeneratedItem[] {
  return kit(c, itemLevel, 'legendary').map((item) =>
    generateItem({
      seed: item.seed,
      itemLevel,
      baseId: item.baseId,
      rarityId: 'legendary',
      classId: c,
    })!,
  );
}

export const upgraded = (items: GeneratedItem[], upgradeLevel: number): GeneratedItem[] =>
  items.map((i) => ({ ...i, upgradeLevel }));

export const winRate = (rs: { bossDefeated: boolean }[]): number =>
  rs.filter((r) => r.bossDefeated).length / rs.length;

/** Win rate per class and the mean over the classes. */
export function rates(f: (c: ClassId) => number): { per: Record<ClassId, number>; mean: number } {
  const per = Object.fromEntries(CLASS_IDS.map((c) => [c, f(c)])) as Record<ClassId, number>;
  return { per, mean: CLASS_IDS.reduce((s, c) => s + per[c], 0) / CLASS_IDS.length };
}
