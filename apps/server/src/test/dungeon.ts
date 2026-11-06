import { eq } from 'drizzle-orm';
import {
  ITEM_BASES,
  canClassUseItem,
  createRng,
  equipmentSlotsForKind,
  generateItem,
  type ClassId,
  type RarityId,
} from '@worldforge/game-core';
import { characters, itemInstances } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';

/**
 * Test helper (ticket 2.5): sets the character's level and equips one uncommon tier-3 item per
 * slot at that level — the gear a crypt-ready hero has collected by farming. Ticket 3.6: another
 * `rarityId` (e.g. Legendaries for the deeper tiers).
 */
export async function makeCryptReady(
  db: Database,
  characterId: string,
  classId: ClassId,
  level: number,
  { gear = true, rarityId = 'uncommon' }: { gear?: boolean; rarityId?: RarityId } = {},
): Promise<void> {
  await db.update(characters).set({ level, experience: 0 }).where(eq(characters.id, characterId));
  if (!gear) return;
  const rng = createRng(`gear:${classId}:${level}`);
  const taken = new Set<string>();
  const rows = [];
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of equipmentSlotsForKind(base.slot)) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel: level,
        baseId: base.id,
        rarityId,
      })!;
      rows.push({ id: uuidv7(), characterId, ...item, equippedSlot: slot, source: 'test' });
    }
  }
  await db.insert(itemInstances).values(rows);
}
