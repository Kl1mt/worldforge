/**
 * Typed registry of the curated Phase 0 art. Mirrors apps/web/public/assets/manifest.json
 * (a test keeps the two in sync), so components get paths and native sizes without a fetch.
 */
export interface SpriteAsset {
  path: string;
  width: number;
  height: number;
  /** Source orientation; the scene mirrors `right`-facing enemies so they face the hero. */
  facing?: 'front' | 'right';
}

const item = (name: string): SpriteAsset => ({
  path: `/assets/items/${name}.png`,
  width: 32,
  height: 32,
});

export const ASSETS = {
  'item.longsword': item('longsword'),
  'item.longsword-notched': item('longsword-notched'),
  'item.skull-staff': item('skull-staff'),
  'item.hunting-bow': item('hunting-bow'),
  'item.iron-helm': item('iron-helm'),
  'item.horned-helm': item('horned-helm'),
  'item.leather-gloves': item('leather-gloves'),
  'item.iron-gauntlets': item('iron-gauntlets'),
  'item.chainmail': item('chainmail'),
  'item.plate-cuirass': item('plate-cuirass'),
  'item.leather-jerkin': item('leather-jerkin'),
  'item.leather-boots': item('leather-boots'),
  'item.brass-ring': item('brass-ring'),
  'item.iron-ring': item('iron-ring'),
  'item.bone-amulet': item('bone-amulet'),
  'item.round-shield': item('round-shield'),
  'item.heater-shield': item('heater-shield'),
  'enemy.undead-farmer': {
    path: '/assets/enemies/undead-farmer.png',
    width: 64,
    height: 64,
    facing: 'front',
  },
  'enemy.wolf': { path: '/assets/enemies/wolf.png', width: 64, height: 64, facing: 'right' },
  'enemy.skeletal-scarecrow': {
    path: '/assets/enemies/skeletal-scarecrow.png',
    width: 64,
    height: 64,
    facing: 'front',
  },
  'character.warrior': {
    path: '/assets/characters/warrior.png',
    width: 128,
    height: 128,
    facing: 'front',
  },
  'area.abandoned-fields': { path: '/assets/areas/abandoned-fields.png', width: 384, height: 216 },
} as const satisfies Record<string, SpriteAsset>;

export type AssetId = keyof typeof ASSETS;
export type ItemAssetId = Extract<AssetId, `item.${string}`>;
export type EnemyAssetId = Extract<AssetId, `enemy.${string}`>;

export function asset(id: AssetId): SpriteAsset {
  return ASSETS[id];
}
