import { MATERIAL_IDS, type MaterialId } from './materials.js';

/**
 * Community projects and world state (ticket 4.6, GDD §12, docs/COMMUNITY.md).
 *
 * Global projects are data: each has stages, and each stage needs gold and materials. Any player
 * contributes from one of their heroes' holdings; the server keeps the shared totals exact (one
 * lock per project, same transaction as the spend and the audit row). Finishing the last stage
 * sets the project's **world flag**, which content reads (`UnlockRule.worldFlag`; the Warehouse
 * building in 4.7, the Ashen Pass area in 4.8). Flags are global, never per character.
 *
 * No monopoly (GDD §12.2): one player (account, all heroes together) may give at most
 * `capShare` of each need of a stage per contribution window (the UTC day of the game clock).
 * Ticket B.3: the share grows by `capGrowthPerDay` for every day the stage has stood since its
 * first gift, up to `capShareMax`, so a stage still needs five players on its first day (ten for
 * the Forgeward Outpost's stages, `capShare: 0.1`, ticket B.5b; a big town can't hand it to a
 * few), while a small town is not held for weeks. Contributor rewards are
 * achievements only (cosmetic, ticket 4.2), never power.
 *
 * Tuning (ticket B.3): the needs, `capShare` (per stage, or the default in
 * `COMMUNITY_PROJECT_CONFIG`) and the order of the projects are all data here.
 */

/** Global world flags, set only by completed community projects. Never rename or reuse an id. */
export const WORLD_FLAG_IDS = ['warehouseRestored', 'ashenPassCleared', 'forgewardRaised'] as const;
export type WorldFlagId = (typeof WORLD_FLAG_IDS)[number];

/** Which world flags are set. Read from the server's world state (one source of truth). */
export type WorldFlags = Readonly<Record<WorldFlagId, boolean>>;

export const NO_WORLD_FLAGS: WorldFlags = Object.freeze(
  Object.fromEntries(WORLD_FLAG_IDS.map((id) => [id, false])) as Record<WorldFlagId, boolean>,
);

export function isWorldFlagId(value: unknown): value is WorldFlagId {
  return typeof value === 'string' && (WORLD_FLAG_IDS as readonly string[]).includes(value);
}

/** Flags from the set ids (unknown ids are ignored, so an old flag row never breaks a read). */
export function worldFlagsFrom(ids: Iterable<string>): WorldFlags {
  const flags: Record<WorldFlagId, boolean> = { ...NO_WORLD_FLAGS };
  for (const id of ids) if (isWorldFlagId(id)) flags[id] = true;
  return flags;
}

export interface WorldFlagDefinition {
  id: WorldFlagId;
  /** What it opens, as the player reads it. */
  opens: string;
  /** Shown on something it keeps closed. */
  lockedText: string;
}

export const WORLD_FLAGS: readonly WorldFlagDefinition[] = [
  {
    id: 'warehouseRestored',
    opens: 'The Graumark Warehouse',
    lockedText: 'The town must restore the Warehouse first.',
  },
  {
    id: 'ashenPassCleared',
    opens: 'The Ashen Pass',
    lockedText: 'The town must clear the Ashen Pass first.',
  },
  {
    // Ticket 6.7: the Forgeward Outpost. Today it opens the Forgeward bellows (a town upgrade,
    // `world/town.ts`) and the Forgeward Age (`world/eras.ts`); later content may also read it.
    // It gates nothing players can reach today (the Verge, the Depths and the Tyrant stay open).
    id: 'forgewardRaised',
    opens: 'The Forgeward Outpost',
    lockedText: 'The town must rebuild the Forgeward Outpost first.',
  },
];

export function getWorldFlag(id: WorldFlagId): WorldFlagDefinition {
  return WORLD_FLAGS.find((f) => f.id === id)!;
}

/** What a stage needs: gold or a material. */
export type ProjectResource = 'gold' | MaterialId;
export const PROJECT_RESOURCES: readonly ProjectResource[] = ['gold', ...MATERIAL_IDS];

export function isProjectResource(value: unknown): value is ProjectResource {
  return typeof value === 'string' && (PROJECT_RESOURCES as readonly string[]).includes(value);
}

export interface ProjectNeed {
  resource: ProjectResource;
  amount: number;
}

export interface ProjectStageDefinition {
  /** Unique within the project; never rename (progress rows keep it). */
  id: string;
  name: string;
  description: string;
  /** Distinct resources, positive amounts. The stage is done when every need is met. */
  needs: readonly ProjectNeed[];
  /** Overrides `COMMUNITY_PROJECT_CONFIG.capShare` for this stage. */
  capShare?: number;
}

export interface CommunityProjectDefinition {
  /** Never rename or reuse (rows and achievements keep it). */
  id: string;
  name: string;
  description: string;
  /** Opens only once this project is complete (null: open from the start). */
  requires: string | null;
  stages: readonly ProjectStageDefinition[];
  /** Set for everyone when the last stage is done. */
  grantsFlag: WorldFlagId;
  /** Awarded to every account that contributed when the project completes (cosmetic). */
  rewardAchievementId: string;
}

export const COMMUNITY_PROJECT_CONFIG = {
  /**
   * Default per-player cap on a stage's first day: the share of each need of a stage one account
   * may give per window. 0.2 → five players are needed to finish a stage on its first day.
   */
  capShare: 0.2,
  /**
   * Ticket B.3: added to the share for every whole day (window) since the stage's first gift
   * (0.2 → 20 %, 40 %, 60 % …): one player alone finishes a stage in three days instead of five.
   */
  capGrowthPerDay: 0.2,
  /** Ticket B.3: the share never grows past this (no single account gives more of a need a day). */
  capShareMax: 0.6,
} as const;

export interface CommunityProjectConfig {
  capShare: number;
  capGrowthPerDay: number;
  capShareMax: number;
}

/**
 * Sizing (docs/COMMUNITY.md "Numbers"): a realistic hero earns ~300–1,650 gold and gathers
 * ~40–60 units of its area's materials per hour of farming (docs/ECONOMY.md). Ticket B.3 left the
 * needs alone (they are a one-off sink, and lowering a need under what a live stage holds would
 * strand it) and made the cap grow with a stage's age: days per stage are 3 for one player, 2 for
 * two to four, 1 from five (`balance/community-balance.test.ts`).
 */
export const COMMUNITY_PROJECTS: readonly CommunityProjectDefinition[] = [
  {
    id: 'restoreWarehouse',
    name: 'Restore the Graumark Warehouse',
    description:
      'The old storehouse by the road has stood empty since the fields died. Mend it, and every hero in town gets a place to keep what the pack cannot hold.',
    requires: null,
    grantsFlag: 'warehouseRestored',
    rewardAchievementId: 'warehouseRestorer',
    stages: [
      {
        id: 'clearRubble',
        name: 'Clear the rubble',
        description: 'Haul out the rot and shore up the frame with fresh timber.',
        // Ticket B.3: timber 400 → 250 (a small town is held by materials, not the cap).
        needs: [
          { resource: 'gold', amount: 4_000 },
          { resource: 'timber', amount: 250 },
        ],
      },
      {
        id: 'raiseRoof',
        name: 'Raise the roof',
        description: 'New beams, and hides stretched and tarred against the rain.',
        // Ticket B.3: timber and raw hide 300 → 200 each.
        needs: [
          { resource: 'gold', amount: 8_000 },
          { resource: 'timber', amount: 200 },
          { resource: 'rawHide', amount: 200 },
        ],
      },
      {
        id: 'ironDoors',
        name: 'Hang the iron doors',
        description: 'Hinges, bands and locks from the smith, and a keeper to mind them.',
        // Ticket B.3: iron ore 250 → 200.
        needs: [
          { resource: 'gold', amount: 12_000 },
          { resource: 'ironOre', amount: 200 },
        ],
      },
    ],
  },
  {
    id: 'clearAshenPass',
    name: 'Clear the Ashen Pass',
    description:
      'Beyond the Abbey the road climbs into ash and old fire. Scouts, wardstones and a broken seal stand between the town and the pass.',
    requires: 'restoreWarehouse',
    grantsFlag: 'ashenPassCleared',
    rewardAchievementId: 'ashenPassBreaker',
    stages: [
      {
        id: 'scoutPass',
        name: 'Scout the pass',
        description: 'Outfit scouts with charms against the dead and salves for the burns.',
        needs: [
          { resource: 'gold', amount: 15_000 },
          { resource: 'soulShard', amount: 300 },
          { resource: 'ashwort', amount: 200 },
        ],
      },
      {
        id: 'wardstones',
        name: 'Raise the wardstones',
        description: 'Iron-bound stones along the road, inlaid with Abbey silver.',
        needs: [
          { resource: 'gold', amount: 30_000 },
          { resource: 'ironOre', amount: 500 },
          { resource: 'abbeySilver', amount: 40 },
        ],
      },
      {
        id: 'breakWard',
        name: 'Break the warden’s ward',
        description: 'The Gravewarden’s seals answer the old ward at the summit. Bring enough.',
        needs: [
          { resource: 'gold', amount: 45_000 },
          { resource: 'abbeySilver', amount: 60 },
          { resource: 'gravewardenSeal', amount: 10 },
        ],
      },
    ],
  },
  {
    // Ticket 6.7 (docs/COMMUNITY.md "The Forgeward Outpost"): the Cinderwastes chain. A late-game
    // sink sized for a town of about twenty (a week or two), finished in a day or two by a big
    // one; the Tyrant's Ember only in the last stage, and few of them.
    // Ticket B.5b (owner decision): every stage starts at a tenth a day (`capShare: 0.1`), so a
    // stage needs ten givers on its first day; it grows by the default rule (30 %, 50 %, 60 %).
    id: 'forgewardOutpost',
    name: 'Rebuild the Forgeward Outpost',
    description:
      'Past the Ashen Pass the old forgeward fort stands burnt to its footings. Rebuild it as a waystation for the Cinderwastes, and the town’s smiths get a fire worth working at.',
    requires: 'clearAshenPass',
    grantsFlag: 'forgewardRaised',
    rewardAchievementId: 'forgewardBuilder',
    stages: [
      {
        id: 'slagRoad',
        name: 'Clear the slag road',
        description: 'Break the cooled slag off the old road and shore the cuttings with iron.',
        capShare: 0.1,
        needs: [
          { resource: 'gold', amount: 60_000 },
          { resource: 'ironOre', amount: 1_000 },
          { resource: 'soulShard', amount: 400 },
        ],
      },
      {
        id: 'forgewardWalls',
        name: 'Raise the forgeward walls',
        description: 'Iron-banded walls on the old footings, the gate set with Abbey silver.',
        capShare: 0.1,
        needs: [
          { resource: 'gold', amount: 100_000 },
          { resource: 'ironOre', amount: 1_500 },
          { resource: 'abbeySilver', amount: 80 },
        ],
      },
      {
        id: 'kindleBeacon',
        name: 'Kindle the beacon',
        description: 'Only the Tyrant’s own fire will light the beacon on the forgeward tower.',
        capShare: 0.1,
        needs: [
          { resource: 'gold', amount: 140_000 },
          { resource: 'soulShard', amount: 800 },
          { resource: 'tyrantsEmber', amount: 10 },
        ],
      },
    ],
  },
];

export type CommunityProjectId = string;

export const COMMUNITY_PROJECT_IDS: readonly string[] = COMMUNITY_PROJECTS.map((p) => p.id);

export function findCommunityProject(id: string): CommunityProjectDefinition | undefined {
  return COMMUNITY_PROJECTS.find((p) => p.id === id);
}

/**
 * The share of each need one account may give to a stage in one window, `ageDays` whole windows
 * after the stage's first gift (ticket B.3; 0 on the first day and for a stage nobody gave to yet).
 */
export function stageCapShare(
  stage: ProjectStageDefinition,
  ageDays = 0,
  config: CommunityProjectConfig = COMMUNITY_PROJECT_CONFIG,
): number {
  if (!Number.isInteger(ageDays) || ageDays < 0) throw new RangeError(`Invalid age: ${ageDays}`);
  const base = stage.capShare ?? config.capShare;
  // Rounded to nine places so float sums don't creep past a share (0.1 + 0.2 is 0.30000000000000004,
  // which would round a cap up by one; ticket B.5b).
  const grown = Math.round((base + config.capGrowthPerDay * ageDays) * 1e9) / 1e9;
  return Math.min(Math.max(base, config.capShareMax), grown);
}

/** The per-window cap of one account on one need of a stage (at least 1). */
export function stageCap(
  stage: ProjectStageDefinition,
  resource: ProjectResource,
  ageDays = 0,
  config: CommunityProjectConfig = COMMUNITY_PROJECT_CONFIG,
): number {
  const need = stage.needs.find((n) => n.resource === resource);
  if (!need) return 0;
  // The epsilon keeps a product like 1,000 × 0.3 from rounding up on float noise.
  return Math.max(1, Math.ceil(need.amount * stageCapShare(stage, ageDays, config) - 1e-9));
}

/**
 * Whole windows (UTC days) from the stage's first gift (`firstDay`, null if none yet) to `day`
 * (both `YYYY-MM-DD`): the age `stageCap` grows with (ticket B.3).
 */
export function stageAgeDays(firstDay: string | null, day: string): number {
  if (firstDay === null) return 0;
  const ms = Date.parse(`${day}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * The contribution window holding `now`: the game-clock UTC day (the window rule: stored with
 * each contribution, so a request just before midnight counts on the day it committed).
 */
export function contributionWindow(now: Date): { day: string; startsAt: Date; endsAt: Date } {
  const day = now.toISOString().slice(0, 10);
  const startsAt = new Date(`${day}T00:00:00.000Z`);
  return { day, startsAt, endsAt: new Date(startsAt.getTime() + 86_400_000) };
}

export type ResourceAmounts = Partial<Record<ProjectResource, number>>;

/** Whether every need of the stage is met by `delivered`. */
export function isStageComplete(
  stage: ProjectStageDefinition,
  delivered: ResourceAmounts,
): boolean {
  return stage.needs.every((n) => (delivered[n.resource] ?? 0) >= n.amount);
}

/** Why an offer was cut down: the stage's remaining need, or the player's cap in this window. */
export type ContributionLimit = 'stage' | 'cap';

export interface ContributionPlan {
  /** What is taken, per resource (only positive entries). */
  accepted: ResourceAmounts;
  /** Resources whose offer was cut, and by what. */
  limited: Partial<Record<ProjectResource, ContributionLimit>>;
}

/**
 * How much of an offer the stage takes (pure; the server calls it under the project lock, with
 * the totals and the account's window sums read under that lock). Never more than the stage
 * still needs (no over-fill) or the account may still give in this window (the cap); the rest is
 * simply not taken, so nothing offered is lost. Throws for a resource the stage does not need or a
 * non-positive amount (the server validates first).
 */
export function planContribution(
  stage: ProjectStageDefinition,
  delivered: ResourceAmounts,
  givenInWindow: ResourceAmounts,
  offer: ResourceAmounts,
  /** Ticket B.3: whole days since the stage's first gift (`stageAgeDays`); the cap grows with it. */
  ageDays = 0,
): ContributionPlan {
  const accepted: ResourceAmounts = {};
  const limited: ContributionPlan['limited'] = {};
  for (const [resource, amount] of Object.entries(offer) as [ProjectResource, number][]) {
    const need = stage.needs.find((n) => n.resource === resource);
    if (!need) throw new RangeError(`Stage ${stage.id} does not need ${resource}`);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new RangeError(`Invalid amount of ${resource}: ${amount}`);
    }
    const remaining = Math.max(0, need.amount - (delivered[resource] ?? 0));
    const capLeft = Math.max(
      0,
      stageCap(stage, resource, ageDays) - (givenInWindow[resource] ?? 0),
    );
    const take = Math.min(amount, remaining, capLeft);
    if (take < amount) limited[resource] = remaining <= capLeft ? 'stage' : 'cap';
    if (take > 0) accepted[resource] = take;
  }
  return { accepted, limited };
}

/** Whether a project is open: its prerequisite (if any) is complete. */
export function isProjectOpen(
  project: CommunityProjectDefinition,
  completed: ReadonlySet<string>,
): boolean {
  return project.requires === null || completed.has(project.requires);
}
