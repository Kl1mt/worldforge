import {
  MATERIAL_IDS,
  PROFESSIONS,
  getMaterial,
  type MaterialId,
  type ProfessionId,
  type RarityId,
} from '@worldforge/game-core';
import { ASSETS, type AssetId, type SpriteAsset } from '../content/assets';

export interface MaterialView {
  id: MaterialId;
  name: string;
  description: string;
  rarity: RarityId;
  sprite: SpriteAsset | null;
  /** How it is obtained, as one short line. */
  source: string;
}

const PROFESSION_NAME = new Map(PROFESSIONS.map((p) => [p.id, p.name]));

export function professionName(id: ProfessionId): string {
  return PROFESSION_NAME.get(id) ?? id;
}

/** Display data for a material from game-core content and the asset registry (A.4). */
export function materialView(id: MaterialId): MaterialView {
  const def = getMaterial(id);
  const sprite = def.icon in ASSETS ? ASSETS[def.icon as AssetId] : null;
  let source: string;
  if (def.source === 'gathering' && def.profession) source = professionName(def.profession);
  else if (def.source === 'undeadDrop') source = 'Dropped by the undead';
  else source = 'Boss drop';
  return {
    id,
    name: def.name,
    description: def.description,
    rarity: def.rarity,
    sprite,
    source,
  };
}

/** A summary's material counts as display rows in content order (unknown ids are skipped). */
export function materialCounts(
  counts: Partial<Record<string, number>> | undefined,
): { material: MaterialView; quantity: number }[] {
  if (!counts) return [];
  return MATERIAL_IDS.filter((id) => (counts[id] ?? 0) > 0).map((id) => ({
    material: materialView(id),
    quantity: counts[id]!,
  }));
}
