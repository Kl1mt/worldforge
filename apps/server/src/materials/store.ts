import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_PROFESSION_CONFIG,
  MATERIAL_IDS,
  PROFESSION_IDS,
  isMaterialId,
  isProfessionId,
  normalizeProfessions,
  professionXpToNext,
  type MaterialId,
  type ProfessionId,
  type ProfessionLevels,
  type ProfessionState,
} from '@worldforge/game-core';
import { characterMaterials, characterProfessions } from '../db/schema.js';
import type { Database, Transaction } from '../db/types.js';

type Db = Database | Transaction;

/** Stored profession progress; professions without a row are level 1 (game-core default). */
export async function loadProfessions(db: Db, characterId: string): Promise<ProfessionLevels> {
  const rows = await db
    .select()
    .from(characterProfessions)
    .where(eq(characterProfessions.characterId, characterId));
  const partial: Partial<Record<ProfessionId, ProfessionState>> = {};
  for (const r of rows) {
    if (isProfessionId(r.professionId)) {
      partial[r.professionId] = { level: r.level, xp: r.experience };
    }
  }
  return normalizeProfessions(partial);
}

/**
 * Grants a settlement's materials and writes the professions that changed. Call inside the
 * settlement transaction, after the character row is locked (`settleActivityTx`): the lock
 * serialises settlements, so the profession state read before `settleFarming` is still current.
 * Materials are added with `quantity = quantity + n` on conflict.
 */
export async function grantGatheringTx(
  tx: Transaction,
  characterId: string,
  materials: Partial<Record<MaterialId, number>>,
  before: ProfessionLevels,
  after: ProfessionLevels,
  now: Date,
): Promise<void> {
  const rows = (Object.entries(materials) as [MaterialId, number][])
    .filter(([, n]) => n > 0)
    .map(([materialId, quantity]) => ({ characterId, materialId, quantity, updatedAt: now }));
  if (rows.length > 0) {
    await tx
      .insert(characterMaterials)
      .values(rows)
      .onConflictDoUpdate({
        target: [characterMaterials.characterId, characterMaterials.materialId],
        set: {
          quantity: sql`${characterMaterials.quantity} + excluded.quantity`,
          updatedAt: now,
        },
      });
  }
  const changed = PROFESSION_IDS.filter(
    (id) => before[id].level !== after[id].level || before[id].xp !== after[id].xp,
  ).map((professionId) => ({
    characterId,
    professionId,
    level: after[professionId].level,
    experience: after[professionId].xp,
    updatedAt: now,
  }));
  if (changed.length > 0) {
    await tx
      .insert(characterProfessions)
      .values(changed)
      .onConflictDoUpdate({
        target: [characterProfessions.characterId, characterProfessions.professionId],
        set: {
          level: sql`excluded.level`,
          experience: sql`excluded.experience`,
          updatedAt: now,
        },
      });
  }
}

export interface MaterialStackView {
  materialId: MaterialId;
  quantity: number;
}

export interface ProfessionView {
  professionId: ProfessionId;
  level: number;
  /** XP toward the next level (0 at the cap). */
  xp: number;
  /** XP the next level needs; 0 at the cap. */
  xpToNext: number;
  maxLevel: number;
}

export interface MaterialsResponse {
  characterId: string;
  /** Held materials (quantity > 0) in content order. */
  materials: MaterialStackView[];
  /** Every profession, in content order. */
  professions: ProfessionView[];
}

export async function materialsView(db: Db, characterId: string): Promise<MaterialsResponse> {
  const rows = await db
    .select({ materialId: characterMaterials.materialId, quantity: characterMaterials.quantity })
    .from(characterMaterials)
    .where(eq(characterMaterials.characterId, characterId));
  const held = new Map(
    rows.filter((r) => isMaterialId(r.materialId)).map((r) => [r.materialId, r.quantity]),
  );
  const professions = await loadProfessions(db, characterId);
  const maxLevel = DEFAULT_PROFESSION_CONFIG.maxLevel;
  return {
    characterId,
    materials: MATERIAL_IDS.filter((id) => (held.get(id) ?? 0) > 0).map((materialId) => ({
      materialId,
      quantity: held.get(materialId)!,
    })),
    professions: PROFESSION_IDS.map((professionId) => ({
      professionId,
      level: professions[professionId].level,
      xp: professions[professionId].xp,
      xpToNext: professionXpToNext(professions[professionId].level),
      maxLevel,
    })),
  };
}

/** Held materials as a bundle (only positive stacks). Lock the character row first to act on it. */
export async function loadMaterialBundle(
  db: Db,
  characterId: string,
): Promise<Partial<Record<MaterialId, number>>> {
  const rows = await db
    .select({ materialId: characterMaterials.materialId, quantity: characterMaterials.quantity })
    .from(characterMaterials)
    .where(eq(characterMaterials.characterId, characterId));
  const bundle: Partial<Record<MaterialId, number>> = {};
  for (const r of rows)
    if (isMaterialId(r.materialId) && r.quantity > 0) bundle[r.materialId] = r.quantity;
  return bundle;
}

/**
 * Adds (positive) or spends (negative) materials (ticket 2.6: forge salvage and crafting). Call
 * under the character lock after checking the stock; the `quantity >= 0` check constraint is the
 * database backstop against spending what is not there.
 */
export async function changeMaterialsTx(
  tx: Transaction,
  characterId: string,
  delta: Partial<Record<MaterialId, number>>,
  now: Date,
): Promise<void> {
  const entries = (Object.entries(delta) as [MaterialId, number][]).filter(([, n]) => n !== 0);
  const gains = entries
    .filter(([, n]) => n > 0)
    .map(([materialId, quantity]) => ({ characterId, materialId, quantity, updatedAt: now }));
  if (gains.length > 0) {
    await tx
      .insert(characterMaterials)
      .values(gains)
      .onConflictDoUpdate({
        target: [characterMaterials.characterId, characterMaterials.materialId],
        set: {
          quantity: sql`${characterMaterials.quantity} + excluded.quantity`,
          updatedAt: now,
        },
      });
  }
  // Spends update the existing stack (an insert would trip the CHECK before ON CONFLICT).
  for (const [materialId, n] of entries.filter(([, n]) => n < 0)) {
    const spent = await tx
      .update(characterMaterials)
      .set({ quantity: sql`${characterMaterials.quantity} + ${n}`, updatedAt: now })
      .where(
        and(
          eq(characterMaterials.characterId, characterId),
          eq(characterMaterials.materialId, materialId),
        ),
      )
      .returning({ quantity: characterMaterials.quantity });
    if (spent.length === 0) throw new Error(`spending ${materialId} that is not held`);
  }
}
