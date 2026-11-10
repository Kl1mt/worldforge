import { AREAS, DUNGEONS, type AreaId, type DungeonId } from '@worldforge/game-core';
import { findSprite, type SpriteAsset } from './assets';

/**
 * Hub hotspots and world-map markers from A.2 (ticket 2.2), in image pixels of the 384 × 216 art.
 * Mirrors the `hotspots` / `markers` of `hub.graumark` / `map.graumark` in manifest.json (a test
 * keeps them in sync), so screens need no fetch.
 */
export type BuildingId =
  'forge' | 'merchant' | 'tavern' | 'guildHall' | 'warehouse' | 'summoningShrine' | 'worldMap';

export interface Hotspot {
  id: BuildingId;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const HUB_HOTSPOTS: readonly Hotspot[] = [
  { id: 'forge', label: 'Forge', x: 48, y: 88, width: 56, height: 50 },
  { id: 'merchant', label: 'Merchant', x: 106, y: 100, width: 48, height: 42 },
  { id: 'tavern', label: 'Tavern', x: 156, y: 73, width: 72, height: 67 },
  { id: 'guildHall', label: 'Guild Hall', x: 228, y: 70, width: 63, height: 70 },
  { id: 'warehouse', label: 'Warehouse', x: 291, y: 77, width: 74, height: 63 },
  { id: 'summoningShrine', label: 'Summoning Shrine', x: 366, y: 112, width: 18, height: 34 },
  { id: 'worldMap', label: 'World Map', x: 14, y: 138, width: 76, height: 59 },
];

export type MapPlaceId = 'hub' | AreaId | DungeonId;

export interface MapMarker {
  id: MapPlaceId;
  x: number;
  y: number;
}

export const MAP_MARKERS: readonly MapMarker[] = [
  { id: 'hub', x: 197, y: 105 },
  { id: 'abandonedFields', x: 70, y: 95 },
  { id: 'crowwood', x: 188, y: 38 },
  { id: 'oldBurialGrounds', x: 52, y: 170 },
  { id: 'blackwater', x: 225, y: 172 },
  { id: 'sunkenAbbey', x: 320, y: 110 },
  { id: 'namelessCrypt', x: 332, y: 42 },
  // Ticket 4.8: the mountains in the north-west (the map has no painted spot for the pass).
  { id: 'ashenPass', x: 52, y: 40 },
  { id: 'ashenWatch', x: 104, y: 26 },
  // Ticket 6.1: the Cinderwastes beyond the Warden's tower, at the map's north-west corner.
  { id: 'ashfallVerge', x: 46, y: 14 },
  // Ticket 6.2: the Depths below the Verge, the Tyrant's Forge at their bottom (the map's west edge).
  { id: 'cinderDepths', x: 16, y: 34 },
  { id: 'tyrantsForge', x: 18, y: 62 },
];

export function mapMarker(id: MapPlaceId): MapMarker | null {
  return MAP_MARKERS.find((m) => m.id === id) ?? null;
}

/**
 * Looks up art by a content asset id (areas, enemies). Content may name art that has not been
 * made yet; callers then draw their fallback instead of crashing.
 */
export function findAsset(id: string): SpriteAsset | null {
  return findSprite(id);
}

/** Every place on the map, for completeness checks. */
export const MAP_PLACE_IDS: readonly MapPlaceId[] = [
  'hub',
  ...AREAS.map((a) => a.id),
  ...DUNGEONS.map((d) => d.id),
];
