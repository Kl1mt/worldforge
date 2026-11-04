import { BANNERS, type BannerDefinition } from './characters.js';
import { CLASSES, RESOURCES, type ClassDefinition, type ResourceDefinition } from './classes.js';
import { RARITIES, type RarityDefinition } from './rarity.js';
import { EQUIPMENT_SLOTS, type EquipmentSlotDefinition } from './slots.js';
import { CORE_STATS, type StatDefinition } from './stats.js';

/** Bump when the shape of `GameContent` changes in a client-visible way. */
export const CONTENT_VERSION = 2;

export interface GameContent {
  version: number;
  classes: readonly ClassDefinition[];
  resources: readonly ResourceDefinition[];
  rarities: readonly RarityDefinition[];
  equipmentSlots: readonly EquipmentSlotDefinition[];
  stats: readonly StatDefinition[];
  /** Character cosmetic options (ticket 1.3). */
  banners: readonly BannerDefinition[];
}

export function getGameContent(): GameContent {
  return {
    version: CONTENT_VERSION,
    classes: CLASSES,
    resources: RESOURCES,
    rarities: RARITIES,
    equipmentSlots: EQUIPMENT_SLOTS,
    stats: CORE_STATS,
    banners: BANNERS,
  };
}
