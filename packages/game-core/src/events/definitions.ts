import { AREAS } from '../world/areas.js';
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
 * The world modifier, applied server-side to heroes who joined the event while it runs. Each kind
 * keeps a running count per hero and event (`event_participants.bounty_kills`, the "bounty
 * count"), so the bonus does not depend on how farming is split into settlements.
 * - `killBounty` (6.6): every `every` foes of `enemyIds` a hero puts down yield one `materialId`.
 * - `gatherBounty` (8.3): every `every` units of `materialIds` a hero gathers while farming (the
 *   settlement's own materials, never the bonus itself, never a dungeon hoard) yield one
 *   `materialId`.
 */
export type EventModifier =
  | {
      kind: 'killBounty';
      /** Short name, e.g. "The dead rise thick". */
      name: string;
      /** Plain words for the Tavern and the banner. */
      description: string;
      enemyIds: readonly EnemyId[];
      materialId: MaterialId;
      every: number;
    }
  | {
      kind: 'gatherBounty';
      name: string;
      description: string;
      materialIds: readonly MaterialId[];
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
  /** Ticket 8.3: any of several materials, summed. */
  | { kind: 'gatherAny'; materialIds: readonly MaterialId[]; count: number }
  | { kind: 'defeatBoss'; bossIds: readonly EnemyId[] | null; count: number };

export interface EventQuestDefinition {
  id: string;
  name: string;
  description: string;
  objective: EventObjective;
  /** Tallies toward the account's reward track when the quest is done. */
  tallies: number;
  /**
   * Ticket 8.3: the week of the event the quest opens in (1 = from the start; week `w` opens
   * `(w - 1) × 7` days after the start). Requests that arrive before it opens don't advance it.
   * Default 1.
   */
  week?: number;
  /**
   * Ticket 8.3: the hero's level (when the request arrives) the quest needs; below it, the quest
   * doesn't advance. Default: open to every hero.
   */
  minLevel?: number;
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

/** Ticket 8.3: what the Lantern Procession's gathering tasks and its modifier count. */
const LANTERN_MATERIALS: readonly MaterialId[] = ['timber', 'ashwort', 'rawHide', 'ironOre'];

/** Ticket 8.3: the level of the Procession's deeper road (the Cinderwastes open at 28). */
export const LANTERN_DEEP_ROAD_LEVEL = 28;

/** Ticket 8.3: every foe of the Cinderwastes and the Hollow Reach (the deeper road's kill tasks). */
const DEEP_ROAD_FOES: readonly EnemyId[] = [
  ...new Set(
    AREAS.filter((a) => a.region === 'The Cinderwastes' || a.region === 'The Hollow Reach').flatMap(
      (a) => a.enemies.map((e) => e.enemyId),
    ),
  ),
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
  // Ticket 8.3: the longer chase (B.5b): four weeks, a quest line that opens a week at a time,
  // a deeper level-gated road for heroes of 28 and up, and seven keepsakes (docs/EVENTS.md).
  {
    id: 'lanternProcession',
    name: 'The Lantern Procession',
    tagline:
      'A procession of lanterns walks from the town gate to the edge of the Hollow, a stage a week.',
    giver: 'Mother Ansel of the lantern-house',
    description:
      'When the nights grow longest, Graumark walks its lanterns out: from the town gate down the Ashen Road, past the burning Verge, to the edge of the Hollow, one stage each week. The road must be cleared ahead of the lantern-bearers and every lantern needs wick, frame and oil. Mother Ansel marks each task done on the lantern-house wall; those who walk the whole road are not forgotten.',
    tallyName: 'lantern marks',
    defaultDays: 28,
    modifier: {
      kind: 'gatherBounty',
      name: 'Iron for the lantern frames',
      description:
        'Every 25 Timber, Ashwort, Raw Hide or Iron Ore you gather while farming yield an extra Iron Ore for the lantern frames.',
      materialIds: LANTERN_MATERIALS,
      materialId: 'ironOre',
      every: 25,
    },
    quests: [
      // Week 1: the town gate.
      {
        id: 'clearTheGateRoad',
        name: 'Clear the Gate Road',
        description: 'Put down 1,500 foes anywhere, so the procession can leave the gate.',
        objective: { kind: 'kill', enemyIds: null, count: 1500 },
        tallies: 10,
        week: 1,
      },
      {
        id: 'wickAndFrame',
        name: 'Wick and Frame',
        description: 'Gather 150 Timber, Ashwort, Raw Hide or Iron Ore for the first lanterns.',
        objective: { kind: 'gatherAny', materialIds: LANTERN_MATERIALS, count: 150 },
        tallies: 10,
        week: 1,
      },
      {
        id: 'wardensAtTheGate',
        name: 'Wardens at the Gate',
        description: 'Defeat the master of any dungeon twice. For heroes of level 28 and up.',
        objective: { kind: 'defeatBoss', bossIds: null, count: 2 },
        tallies: 15,
        week: 1,
        minLevel: LANTERN_DEEP_ROAD_LEVEL,
      },
      // Week 2: the Ashen Road.
      {
        id: 'theAshenRoad',
        name: 'The Ashen Road',
        description: 'Put down 2,500 foes anywhere along the procession’s road.',
        objective: { kind: 'kill', enemyIds: null, count: 2500 },
        tallies: 15,
        week: 2,
      },
      {
        id: 'oilForTheLanterns',
        name: 'Oil for the Lanterns',
        description: 'Gather 250 Timber, Ashwort, Raw Hide or Iron Ore to keep the lanterns lit.',
        objective: { kind: 'gatherAny', materialIds: LANTERN_MATERIALS, count: 250 },
        tallies: 15,
        week: 2,
      },
      {
        id: 'throughTheCinders',
        name: 'Through the Cinders',
        description:
          'Put down 2,000 foes in the Cinderwastes or the Hollow Reach. For heroes of level 28 and up.',
        objective: { kind: 'kill', enemyIds: DEEP_ROAD_FOES, count: 2000 },
        tallies: 20,
        week: 2,
        minLevel: LANTERN_DEEP_ROAD_LEVEL,
      },
      // Week 3: the burning Verge.
      {
        id: 'holdTheVerge',
        name: 'Hold the Verge',
        description: 'Put down 3,500 foes anywhere while the procession crosses the Verge.',
        objective: { kind: 'kill', enemyIds: null, count: 3500 },
        tallies: 20,
        week: 3,
      },
      {
        id: 'brassForTheFrames',
        name: 'Brass for the Frames',
        description: 'Gather 350 Timber, Ashwort, Raw Hide or Iron Ore for the lantern-house.',
        objective: { kind: 'gatherAny', materialIds: LANTERN_MATERIALS, count: 350 },
        tallies: 20,
        week: 3,
      },
      {
        id: 'keepersOfTheFlame',
        name: 'Keepers of the Flame',
        description: 'Defeat the master of any dungeon four times. For heroes of level 28 and up.',
        objective: { kind: 'defeatBoss', bossIds: null, count: 4 },
        tallies: 25,
        week: 3,
        minLevel: LANTERN_DEEP_ROAD_LEVEL,
      },
      // Week 4: the edge of the Hollow.
      {
        id: 'toTheHollowsEdge',
        name: 'To the Hollow’s Edge',
        description: 'Put down 5,000 foes anywhere on the last stretch of the road.',
        objective: { kind: 'kill', enemyIds: null, count: 5000 },
        tallies: 25,
        week: 4,
      },
      {
        id: 'theLastLight',
        name: 'The Last Light',
        description: 'Gather 450 Timber, Ashwort, Raw Hide or Iron Ore for the last lanterns.',
        objective: { kind: 'gatherAny', materialIds: LANTERN_MATERIALS, count: 450 },
        tallies: 25,
        week: 4,
      },
      {
        id: 'intoTheDark',
        name: 'Into the Dark',
        description:
          'Put down 3,000 foes in the Cinderwastes or the Hollow Reach. For heroes of level 28 and up.',
        objective: { kind: 'kill', enemyIds: DEEP_ROAD_FOES, count: 3000 },
        tallies: 30,
        week: 4,
        minLevel: LANTERN_DEEP_ROAD_LEVEL,
      },
    ],
    track: [
      { tier: 1, tallies: 10, cosmeticId: 'title-colour.wick-amber' },
      { tier: 2, tallies: 30, cosmeticId: 'banner.procession-lantern' },
      { tier: 3, tallies: 60, cosmeticId: 'crest.lantern-brass' },
      { tier: 4, tallies: 100, cosmeticId: 'title-colour.deep-lantern' },
      { tier: 5, tallies: 140, cosmeticId: 'appearance.lantern-bearer' },
      { tier: 6, tallies: 190, cosmeticId: 'banner.hollow-procession' },
      { tier: 7, tallies: 230, cosmeticId: 'title.keeper-of-the-long-road' },
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
