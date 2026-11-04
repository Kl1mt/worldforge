import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AREAS, DUNGEONS, getEnemy } from '@worldforge/game-core';
import { HUB_HOTSPOTS, MAP_MARKERS, MAP_PLACE_IDS, findAsset } from './world';

interface ManifestEntry {
  id: string;
  hotspots?: unknown[];
  markers?: unknown[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../../public/assets/manifest.json', import.meta.url), 'utf8'),
) as { assets: ManifestEntry[] };
const entry = (id: string) => manifest.assets.find((a) => a.id === id);

describe('world layout', () => {
  it('matches the hub hotspots and map markers in manifest.json', () => {
    expect(HUB_HOTSPOTS).toEqual(entry('hub.graumark')?.hotspots);
    expect(MAP_MARKERS).toEqual(entry('map.graumark')?.markers);
  });

  it('has a map marker for the hub, every area and every dungeon', () => {
    expect(MAP_MARKERS.map((m) => m.id).sort()).toEqual([...MAP_PLACE_IDS].sort());
  });

  it('finds art for every area, dungeon and enemy, and null for unknown ids', () => {
    for (const place of [...AREAS, ...DUNGEONS]) expect(findAsset(place.assetId)).not.toBeNull();
    for (const area of AREAS) {
      for (const e of area.enemies) expect(findAsset(getEnemy(e.enemyId).assetId)).not.toBeNull();
    }
    expect(findAsset('area.not-painted-yet')).toBeNull();
    expect(findAsset('toString')).toBeNull();
  });
});
