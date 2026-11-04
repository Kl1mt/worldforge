import type { RarityId } from '@worldforge/game-core';
import type { EnemyAssetId, ItemAssetId } from '../content/assets';

export interface MockEnemy {
  uid: string;
  sprite: EnemyAssetId;
  name: string;
  level: number;
  health: { current: number; max: number };
  /** The enemy the hero is currently striking. */
  targeted?: boolean;
  /** Vertical stagger in sprite pixels so the line reads as depth, not a row. */
  lift: number;
}

export interface AreaInfo {
  name: string;
  region: string;
  danger: number;
  levelRange: string;
  description: string;
}

export type LogEntry =
  | {
      id: string;
      t: string;
      kind: 'hit';
      source: string;
      target: string;
      amount: number;
      crit?: boolean;
    }
  | { id: string; t: string; kind: 'struck'; source: string; amount: number }
  | { id: string; t: string; kind: 'kill'; target: string; xp: number }
  | { id: string; t: string; kind: 'loot'; item: string; rarity: RarityId }
  | { id: string; t: string; kind: 'gold'; amount: number }
  | { id: string; t: string; kind: 'note'; text: string };

export const AREA: AreaInfo = {
  name: 'Abandoned Fields',
  region: 'Graumark',
  danger: 1,
  levelRange: '8–14',
  description:
    'Fallow land below the old reeve’s farm. The dead still walk the furrows they ploughed in life.',
};

export const ENEMIES: MockEnemy[] = [
  {
    uid: 'e1',
    sprite: 'enemy.undead-farmer',
    name: 'Risen Farmhand',
    level: 11,
    health: { current: 41, max: 180 },
    targeted: true,
    lift: 2,
  },
  {
    uid: 'e2',
    sprite: 'enemy.wolf',
    name: 'Carrion Wolf',
    level: 12,
    health: { current: 164, max: 164 },
    lift: 0,
  },
  {
    uid: 'e3',
    sprite: 'enemy.skeletal-scarecrow',
    name: 'Bone Scarecrow',
    level: 13,
    health: { current: 230, max: 230 },
    lift: 4,
  },
];

export const ROSTER: { sprite: EnemyAssetId; name: string; slain: number }[] = [
  { sprite: 'enemy.undead-farmer', name: 'Risen Farmhand', slain: 214 },
  { sprite: 'enemy.wolf', name: 'Carrion Wolf', slain: 97 },
  { sprite: 'enemy.skeletal-scarecrow', name: 'Bone Scarecrow', slain: 38 },
];

export const RECENT_DROPS: { icon: ItemAssetId; name: string; rarity: RarityId }[] = [
  { icon: 'item.leather-gloves', name: 'Harvester’s Grips', rarity: 'rare' },
  { icon: 'item.leather-boots', name: 'Worn Boots', rarity: 'common' },
  { icon: 'item.iron-ring', name: 'Iron Band', rarity: 'uncommon' },
  { icon: 'item.plate-cuirass', name: 'Cuirass of the Last Levy', rarity: 'epic' },
  { icon: 'item.round-shield', name: 'Barn-Door Buckler', rarity: 'common' },
];

/** Newest first. */
export const COMBAT_LOG: LogEntry[] = [
  {
    id: 'l14',
    t: '14:32:07',
    kind: 'hit',
    source: 'You',
    target: 'Risen Farmhand',
    amount: 112,
    crit: true,
  },
  { id: 'l13', t: '14:32:06', kind: 'struck', source: 'Risen Farmhand', amount: 17 },
  { id: 'l12', t: '14:32:05', kind: 'hit', source: 'You', target: 'Risen Farmhand', amount: 61 },
  { id: 'l11', t: '14:32:03', kind: 'note', text: 'A Carrion Wolf and a Bone Scarecrow approach.' },
  { id: 'l10', t: '14:32:01', kind: 'loot', item: 'Cuirass of the Last Levy', rarity: 'epic' },
  { id: 'l09', t: '14:32:01', kind: 'gold', amount: 14 },
  { id: 'l08', t: '14:32:01', kind: 'kill', target: 'Risen Farmhand', xp: 48 },
  { id: 'l07', t: '14:32:00', kind: 'hit', source: 'You', target: 'Risen Farmhand', amount: 64 },
  { id: 'l06', t: '14:31:58', kind: 'struck', source: 'Risen Farmhand', amount: 21 },
  { id: 'l05', t: '14:31:57', kind: 'hit', source: 'You', target: 'Risen Farmhand', amount: 58 },
  { id: 'l04', t: '14:31:55', kind: 'loot', item: 'Iron Band', rarity: 'uncommon' },
  { id: 'l03', t: '14:31:55', kind: 'kill', target: 'Carrion Wolf', xp: 52 },
  {
    id: 'l02',
    t: '14:31:54',
    kind: 'hit',
    source: 'You',
    target: 'Carrion Wolf',
    amount: 109,
    crit: true,
  },
  { id: 'l01', t: '14:31:52', kind: 'struck', source: 'Carrion Wolf', amount: 26 },
];
