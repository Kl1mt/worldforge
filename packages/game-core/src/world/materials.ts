import type { RarityId } from '../rarity.js';
import type { AreaId } from './areas.js';

/** Gathering professions (GDD §11.3). Rules and levels: `professions/` (ticket 2.3). */
export const PROFESSION_IDS = ['mining', 'woodcutting', 'herbalism', 'skinning'] as const;

export type ProfessionId = (typeof PROFESSION_IDS)[number];

export interface ProfessionDefinition {
  id: ProfessionId;
  name: string;
}

export const PROFESSIONS: readonly ProfessionDefinition[] = [
  { id: 'mining', name: 'Mining' },
  { id: 'woodcutting', name: 'Woodcutting' },
  { id: 'herbalism', name: 'Herbalism' },
  { id: 'skinning', name: 'Skinning' },
];

/** Material ids: a shared contract with the art tickets (`docs/ROADMAP.md`, Phase 2). */
export const MATERIAL_IDS = [
  'timber',
  'ashwort',
  'rawHide',
  'ironOre',
  'soulShard',
  'abbeySilver',
  'gravewardenSeal',
  // Ticket 6.2: the Forge Tyrant's boss material (sink: the Tyrantforged Work recipe).
  'tyrantsEmber',
  // Ticket 8.2: the Hollow Sovereign's boss material (sink: the Crownforged Work recipe).
  'crownShard',
] as const;

export type MaterialId = (typeof MATERIAL_IDS)[number];

/**
 * How a material is obtained:
 * - `gathering`: gathered with `profession` while farming one of `areas` (ticket 2.3);
 * - `undeadDrop`: dropped by undead enemies in combat (`EnemyDefinition.undead`);
 * - `bossDrop`: dropped by a dungeon boss (ticket 2.5).
 */
export type MaterialSource = 'gathering' | 'undeadDrop' | 'bossDrop';

export interface MaterialDefinition {
  id: MaterialId;
  name: string;
  description: string;
  /** Asset id `material.<kebab-case id>` (icons from ticket A.4). */
  icon: string;
  rarity: RarityId;
  source: MaterialSource;
  /** Gathering profession; `null` for combat and boss drops. */
  profession: ProfessionId | null;
  /** Areas that list this material (the content contract's "gatherable materials" column). */
  areas: readonly AreaId[];
}

export const MATERIALS: readonly MaterialDefinition[] = [
  {
    id: 'timber',
    name: 'Timber',
    description: 'Seasoned logs from the dead orchards and the crow-haunted woods.',
    icon: 'material.timber',
    rarity: 'common',
    source: 'gathering',
    profession: 'woodcutting',
    areas: ['abandonedFields', 'crowwood'],
  },
  {
    id: 'ashwort',
    name: 'Ashwort',
    description: 'A grey, bitter herb that grows where the ground has been burnt or drowned.',
    icon: 'material.ashwort',
    rarity: 'common',
    source: 'gathering',
    profession: 'herbalism',
    areas: ['abandonedFields', 'blackwater'],
  },
  {
    id: 'rawHide',
    name: 'Raw Hide',
    description: 'Untanned hide stripped from the beasts of Crowwood.',
    icon: 'material.raw-hide',
    rarity: 'common',
    source: 'gathering',
    profession: 'skinning',
    areas: ['crowwood'],
  },
  {
    id: 'ironOre',
    name: 'Iron Ore',
    description: 'Rust-red ore from the marsh banks and the abbey’s collapsed foundations.',
    icon: 'material.iron-ore',
    rarity: 'uncommon',
    source: 'gathering',
    profession: 'mining',
    areas: [
      'blackwater',
      'sunkenAbbey',
      'ashenPass',
      'ashfallVerge',
      'cinderDepths',
      'paleMarches',
      // Ticket 8.2.
      'hollowDeep',
    ],
  },
  {
    id: 'soulShard',
    name: 'Soul Shard',
    description: 'A cold splinter of what once animated the dead.',
    icon: 'material.soul-shard',
    rarity: 'uncommon',
    source: 'undeadDrop',
    profession: null,
    areas: [
      'oldBurialGrounds',
      'ashenPass',
      'ashfallVerge',
      'cinderDepths',
      'paleMarches',
      'hollowDeep',
    ],
  },
  {
    id: 'abbeySilver',
    name: 'Abbey Silver',
    description: 'Tarnished silver from the drowned abbey’s treasury veins. Rarely found.',
    icon: 'material.abbey-silver',
    rarity: 'rare',
    source: 'gathering',
    profession: 'mining',
    areas: ['sunkenAbbey'],
  },
  {
    id: 'gravewardenSeal',
    name: 'Gravewarden’s Seal',
    description: 'The iron seal the Gravewarden kept the crypt shut with.',
    icon: 'material.gravewarden-seal',
    rarity: 'epic',
    source: 'bossDrop',
    profession: null,
    areas: [],
  },
  {
    id: 'tyrantsEmber',
    name: 'Tyrant’s Ember',
    description:
      'A coal from the Forge Tyrant’s furnace heart. It never cools; smiths say it remembers every blade.',
    icon: 'material.tyrants-ember',
    rarity: 'epic',
    source: 'bossDrop',
    profession: null,
    areas: [],
  },
  {
    // Ticket 8.2: one per Hollow Sovereign hoard; never traded (`UNTRADEABLE_MATERIALS`). Its one
    // sink is the Crownforged Work recipe (docs/ECONOMY.md "The Hollow Throne").
    id: 'crownShard',
    name: 'Shard of the Hollow Crown',
    description:
      'A sliver of the Sovereign’s crown, cold as the deep. Smiths say it still wants a head to sit on.',
    icon: 'material.crown-shard',
    rarity: 'epic',
    source: 'bossDrop',
    profession: null,
    areas: [],
  },
];

const MATERIALS_BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));

export function isMaterialId(value: unknown): value is MaterialId {
  return typeof value === 'string' && (MATERIAL_IDS as readonly string[]).includes(value);
}

export function getMaterial(id: MaterialId): MaterialDefinition {
  const def = MATERIALS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown material: ${id}`);
  return def;
}

export function isProfessionId(value: unknown): value is ProfessionId {
  return typeof value === 'string' && (PROFESSION_IDS as readonly string[]).includes(value);
}
