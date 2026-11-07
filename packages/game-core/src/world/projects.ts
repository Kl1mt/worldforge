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
 * `capShare` of each need of a stage per contribution window (the UTC day of the game clock), so
 * a stage takes at least `1 / capShare` player-days whoever plays. Contributor rewards are
 * achievements only (cosmetic, ticket 4.2), never power.
 *
 * Tuning (ticket B.3): the needs, `capShare` (per stage, or the default in
 * `COMMUNITY_PROJECT_CONFIG`) and the order of the projects are all data here.
 */

/** Global world flags, set only by completed community projects. Never rename or reuse an id. */
export const WORLD_FLAG_IDS = ['warehouseRestored', 'ashenPassCleared'] as const;
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
   * Default per-player cap: the share of each need of a stage one account may give per window.
   * 0.2 → a stage takes at least five player-days, whoever plays.
   */
  capShare: 0.2,
} as const;

/**
 * Sizing (docs/COMMUNITY.md "Numbers"): a realistic hero earns ~300–1,650 gold and gathers
 * ~40–60 units of its area's materials per hour of farming (docs/ECONOMY.md). With the 20 % daily
 * cap a stage needs ≥ 5 player-days; the Warehouse (3 stages) is done in ~4 days by four players
 * who each give their daily share, the Ashen Pass in about the same once players reach the Abbey.
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
        needs: [
          { resource: 'gold', amount: 4_000 },
          { resource: 'timber', amount: 400 },
        ],
      },
      {
        id: 'raiseRoof',
        name: 'Raise the roof',
        description: 'New beams, and hides stretched and tarred against the rain.',
        needs: [
          { resource: 'gold', amount: 8_000 },
          { resource: 'timber', amount: 300 },
          { resource: 'rawHide', amount: 300 },
        ],
      },
      {
        id: 'ironDoors',
        name: 'Hang the iron doors',
        description: 'Hinges, bands and locks from the smith, and a keeper to mind them.',
        needs: [
          { resource: 'gold', amount: 12_000 },
          { resource: 'ironOre', amount: 250 },
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
];

export type CommunityProjectId = string;

export const COMMUNITY_PROJECT_IDS: readonly string[] = COMMUNITY_PROJECTS.map((p) => p.id);

export function findCommunityProject(id: string): CommunityProjectDefinition | undefined {
  return COMMUNITY_PROJECTS.find((p) => p.id === id);
}

/** The per-window cap of one account on one need of a stage (at least 1). */
export function stageCap(stage: ProjectStageDefinition, resource: ProjectResource): number {
  const need = stage.needs.find((n) => n.resource === resource);
  if (!need) return 0;
  const share = stage.capShare ?? COMMUNITY_PROJECT_CONFIG.capShare;
  return Math.max(1, Math.ceil(need.amount * share));
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
    const capLeft = Math.max(0, stageCap(stage, resource) - (givenInWindow[resource] ?? 0));
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
