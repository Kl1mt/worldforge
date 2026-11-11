import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';

/**
 * Rotating events (ticket 6.6, docs/EVENTS.md). An event definition is content: a theme, one world
 * modifier, a short quest line in the Tavern and a cosmetic reward track. The server schedules
 * instances of a definition (one at a time, start and end in UTC); these rules decide what the
 * definition does while an instance runs. **Events never grant power**: the modifier adds a modest,
 * documented amount of one material and nothing else; quests pay tallies toward the track; the
 * track pays cosmetics (`cosmetics/catalogue.ts`). No XP, gold, items or drop odds change.
 */

/**
 * The world modifier, applied server-side to heroes who joined the event while it runs.
 * - `killBounty`: every `every` foes of `enemyIds` a hero puts down (a running count per hero and
 *   event, so the bonus does not depend on how farming is split into settlements) yield one
 *   `materialId`.
 */
export type EventModifier = {
  kind: 'killBounty';
  /** Short name, e.g. "The dead rise thick". */
  name: string;
  /** Plain words for the Tavern and the banner. */
  description: string;
  enemyIds: readonly EnemyId[];
  materialId: MaterialId;
  every: number;
};

/**
 * An event quest's goal. Like `QuestObjective`, fed by the same server-side quest events
 * (settlements, dungeon claims); `null` lists mean "any".
 */
export type EventObjective =
  | { kind: 'kill'; enemyIds: readonly EnemyId[] | null; count: number }
  | { kind: 'gather'; materialId: MaterialId; count: number }
  | { kind: 'defeatBoss'; bossIds: readonly EnemyId[] | null; count: number };

export interface EventQuestDefinition {
  id: string;
  name: string;
  description: string;
  objective: EventObjective;
  /** Tallies toward the account's reward track when the quest is done. */
  tallies: number;
}

export interface EventTrackTier {
  tier: number;
  /** Tallies the account needs (summed over its heroes). */
  tallies: number;
  cosmeticId: string;
}

export interface EventDefinition {
  id: string;
  name: string;
  /** One line for the banner. */
  tagline: string;
  /** Who posts it in the Tavern. */
  giver: string;
  /** The Tavern notice. */
  description: string;
  /** What the event is called in the track's currency ("bone tallies"). */
  tallyName: string;
  /** Suggested length for the admin form and the CLI. */
  defaultDays: number;
  modifier: EventModifier;
  quests: readonly EventQuestDefinition[];
  track: readonly EventTrackTier[];
}

/** The risen dead of the Fields and the Burial Grounds (the Harvest's modifier and first quest). */
const RISEN_OF_THE_FIELDS: readonly EnemyId[] = [
  'risenFarmhand',
  'boneScarecrow',
  'risenSkeleton',
  'graveCrawler',
];

export const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  {
    id: 'harvestOfBones',
    name: 'Harvest of Bones',
    tagline: 'The dead rise thick in the fields; the Reeve pays in bone tallies.',
    giver: 'Old Reeve Hadric',
    description:
      'Every autumn the furrows give back what they were given. This year the risen come up through the stubble faster than the scythes can lay them down. The Reeve is counting every jawbone brought to the shrine, and those who help bring in this grim harvest will be remembered for it.',
    tallyName: 'bone tallies',
    defaultDays: 7,
    modifier: {
      kind: 'killBounty',
      name: 'The dead rise thick',
      description:
        'In the Abandoned Fields and the Old Burial Grounds, every 40 of the risen dead you put down yield an extra Soul Shard.',
      enemyIds: RISEN_OF_THE_FIELDS,
      materialId: 'soulShard',
      every: 40,
    },
    quests: [
      {
        id: 'turnTheFurrows',
        name: 'Turn the Furrows',
        description:
          'Put down 60 of the risen dead in the Abandoned Fields or the Old Burial Grounds.',
        objective: { kind: 'kill', enemyIds: RISEN_OF_THE_FIELDS, count: 60 },
        tallies: 10,
      },
      {
        id: 'ossuaryTithe',
        name: 'The Ossuary Tithe',
        description:
          'Bring 12 Soul Shards to the shrine: from the dead you fell, or the Harvest’s own.',
        objective: { kind: 'gather', materialId: 'soulShard', count: 12 },
        tallies: 10,
      },
      {
        id: 'theLongReaping',
        name: 'The Long Reaping',
        description: 'Put down 400 foes, anywhere in Graumark and beyond.',
        objective: { kind: 'kill', enemyIds: null, count: 400 },
        tallies: 15,
      },
      {
        id: 'stillAWarden',
        name: 'Still a Warden',
        description:
          'Defeat the master of any dungeon: the Gravewarden, the Ashen Warden or the Forge Tyrant.',
        objective: { kind: 'defeatBoss', bossIds: null, count: 1 },
        tallies: 15,
      },
    ],
    track: [
      { tier: 1, tallies: 10, cosmeticId: 'banner.harvest-sheaf' },
      { tier: 2, tallies: 25, cosmeticId: 'title-colour.bone-white' },
      { tier: 3, tallies: 50, cosmeticId: 'title.reaper-of-the-harvest' },
    ],
  },
];

export const EVENT_IDS = EVENT_DEFINITIONS.map((d) => d.id);

const BY_ID = new Map(EVENT_DEFINITIONS.map((d) => [d.id, d]));

export function findEventDefinition(id: string): EventDefinition | undefined {
  return BY_ID.get(id);
}

export function getEventDefinition(id: string): EventDefinition {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown event definition: ${id}`);
  return def;
}
