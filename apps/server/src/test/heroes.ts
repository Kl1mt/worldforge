import type { ClassId, EquipmentSlotId, RarityId, WorldProgress } from '@worldforge/game-core';
import { characterQuests, characters, itemInstances, type Character } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';

let seq = 0;

/** A character inserted directly (test stand-in for the creation route), ticket 4.2. */
export async function insertCharacter(
  db: Database,
  accountId: string,
  {
    id = uuidv7(),
    name,
    classId = 'warrior',
    level = 1,
    progress = { gravewardenDefeated: false },
  }: {
    /** Pin the id when a test needs a known per-character seed (merchant stock, F.7). */
    id?: string;
    name?: string;
    classId?: ClassId;
    level?: number;
    progress?: WorldProgress;
  } = {},
): Promise<Character> {
  seq += 1;
  const [row] = await db
    .insert(characters)
    .values({
      id,
      accountId,
      name: name ?? `Hero${seq}x${Math.floor(Math.random() * 1e6)}`,
      classId,
      appearance: { banner: 'ash' },
      level,
      progress,
    })
    .returning();
  return row!;
}

/** An item row inserted directly. */
export async function insertItem(
  db: Database,
  characterId: string,
  {
    baseId = 'longsword',
    rarityId = 'common',
    upgradeLevel = 0,
    equippedSlot = null,
    setId = null,
    inWarehouse = false,
    locked = false,
  }: {
    baseId?: string;
    rarityId?: RarityId;
    upgradeLevel?: number;
    equippedSlot?: EquipmentSlotId | null;
    setId?: string | null;
    inWarehouse?: boolean;
    locked?: boolean;
  } = {},
) {
  const [row] = await db
    .insert(itemInstances)
    .values({
      id: uuidv7(),
      characterId,
      baseId,
      rarityId,
      itemLevel: 10,
      affixes: [],
      seed: 1,
      equippedSlot,
      source: 'test',
      upgradeLevel,
      setId,
      inWarehouse,
      locked,
    })
    .returning();
  return row!;
}

/** A turned-in quest row (story or contract). */
export async function insertTurnedInQuest(
  db: Database,
  characterId: string,
  kind: 'story' | 'contract',
  questId: string,
  slot = 0,
) {
  const at = new Date();
  await db.insert(characterQuests).values({
    id: uuidv7(),
    characterId,
    kind,
    questId,
    ...(kind === 'contract'
      ? {
          contractDay: `2026-10-${String(1 + (slot % 28)).padStart(2, '0')}`,
          contractSlot: Math.floor(slot / 28),
        }
      : {}),
    objectives: [],
    progress: [],
    reward: { xp: 0, gold: 0, materials: {}, item: null },
    status: 'turnedIn',
    acceptedAt: at,
    turnedInAt: at,
  });
}
