import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  integer,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  AreaId,
  CharacterAppearance,
  ClassId,
  ItemVariantId,
  DungeonId,
  DungeonTier,
  EquipmentSlotId,
  GuideState,
  LootFilterRules,
  MaterialId,
  ProfessionId,
  QuestObjective,
  QuestReward,
  RarityId,
  RolledAffix,
  WorldProgress,
} from '@worldforge/game-core';

/**
 * Database schema (see docs/DATA_MODEL.md). Only player/world *state* lives here;
 * content definitions stay in @worldforge/game-core and are referenced by string id.
 * Later tickets add their own tables and migrations.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    /** Stored as entered (trimmed); uniqueness is case-insensitive via `lower(email)`. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** argon2id/scrypt PHC string, written by ticket 1.2. Never the plain password. */
    passwordHash: text('password_hash').notNull(),
    characterSlots: smallint('character_slots').notNull().default(2),
    /**
     * The character the account last selected (ticket 1.3); kept per account so it follows the
     * player across devices. The server only ever sets it to one of the account's own characters.
     */
    activeCharacterId: uuid('active_character_id').references((): AnyPgColumn => characters.id, {
      onDelete: 'set null',
    }),
    /**
     * First-session guide (ticket 2.7): steps seen done and whether it was dismissed. Per account
     * so it follows the player across devices; it grants nothing (UI state only).
     */
    guide: jsonb('guide')
      .$type<GuideState>()
      .notNull()
      .default(sql`'{"steps":[],"dismissed":false}'::jsonb`),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_email_lower_key').on(sql`lower(${t.email})`),
    uniqueIndex('accounts_display_name_lower_key').on(sql`lower(${t.displayName})`),
    check('accounts_character_slots_check', sql`${t.characterSlots} >= 0`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 hex of the random session token; the raw token is never stored. */
    id: text('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ...timestamps,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_account_id_idx').on(t.accountId),
    check('sessions_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/** Player characters (ticket 1.3, GDD §5). Content (the class) is referenced by game-core id. */
export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Stored trimmed as entered; unique case-insensitively across all accounts. */
    name: text('name').notNull(),
    /** game-core `ClassId`; validated by the server, immutable after creation. */
    classId: text('class_id').$type<ClassId>().notNull(),
    /** Cosmetic choices (game-core `CharacterAppearance`). */
    appearance: jsonb('appearance').$type<CharacterAppearance>().notNull(),
    level: integer('level').notNull().default(1),
    /** Experience within the current level. */
    experience: bigint('experience', { mode: 'number' }).notNull().default(0),
    gold: bigint('gold', { mode: 'number' }).notNull().default(0),
    /**
     * Farming state saved when the character's activity ends and restored when it starts again
     * (ticket 1.9), so stop → start cannot heal the character or re-roll its next encounter.
     * Never sent to clients (it holds the seed secret). Null until the first activity ends.
     */
    farmState: jsonb('farm_state').$type<FarmState>(),
    /**
     * World progress that unlocks depend on besides the level (ticket 2.2, game-core
     * `WorldProgress`). Written only by the server (the Gravewarden kill: ticket 2.5).
     */
    progress: jsonb('progress')
      .$type<WorldProgress>()
      .notNull()
      .default({ gravewardenDefeated: false }),
    /**
     * Loot filter rules (ticket 3.7, game-core `LootFilterRules`); null = no filter. Written only
     * by `POST …/loot-filter` (validated, after settling with the old rules); read by settlement
     * and the crypt claim under the character lock, so each window uses one well-defined set.
     */
    lootFilter: jsonb('loot_filter').$type<LootFilterRules>(),
    /** Optimistic-concurrency counter for later value-changing writes. */
    version: integer('version').notNull().default(0),
    ...timestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('characters_account_id_idx').on(t.accountId),
    uniqueIndex('characters_name_lower_key').on(sql`lower(${t.name})`),
    check('characters_level_check', sql`${t.level} >= 1`),
    check('characters_experience_check', sql`${t.experience} >= 0`),
    check('characters_gold_check', sql`${t.gold} >= 0`),
  ],
);

/**
 * One owned item. Created from a game-core `GeneratedItem` (loot, ticket 1.5); the server is the only
 * writer. An item is in the character's inventory when `equipped_slot` is null, otherwise equipped in
 * that slot. Shared by ticket 1.6 (granting loot) and ticket 1.7 (inventory & equipment).
 */
export const itemInstances = pgTable(
  'item_instances',
  {
    id: uuid('id').primaryKey(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** game-core item base id. */
    baseId: text('base_id').notNull(),
    rarityId: text('rarity_id').$type<RarityId>().notNull(),
    itemLevel: integer('item_level').notNull(),
    affixes: jsonb('affixes').$type<RolledAffix[]>().notNull().default([]),
    /** The generation seed (uint32), kept for audit and reproducibility. */
    seed: bigint('seed', { mode: 'number' }).notNull(),
    /** Null while in the inventory; the game-core `EquipmentSlotId` while equipped. */
    equippedSlot: text('equipped_slot').$type<EquipmentSlotId>(),
    /** Where the item came from, e.g. `farming`. */
    source: text('source').notNull(),
    // Item model v2 (ticket 3.1): every Phase 3 column, unused until its ticket. See DATA_MODEL.md.
    /** Upgrade level +0…+10 (ticket 3.4). */
    upgradeLevel: integer('upgrade_level').notNull().default(0),
    /** Failed upgrades since the last success; the pity guarantee reads it (ticket 3.4). */
    upgradePity: integer('upgrade_pity').notNull().default(0),
    /**
     * Server-only secret of this item's forge seed stream (ticket 3.4). Random per row, never sent
     * to clients; the generation seed alone is not secret enough (merchant seeds derive from
     * public inputs).
     */
    forgeSecret: uuid('forge_secret').notNull().defaultRandom(),
    /** Draws taken from this item's forge seed stream; advances on every random forge outcome. */
    forgeCounter: integer('forge_counter').notNull().default(0),
    /** Affix rerolls done on this item; the reroll cost rises with it (ticket 3.4). */
    rerollCount: integer('reroll_count').notNull().default(0),
    /** Null or a game-core `ItemVariantId` (ticket 3.5; only `void` in Phase 3). */
    variant: text('variant').$type<ItemVariantId>(),
    /** Legendary effect / Mythic signature id in the effect registry (ticket 3.2). */
    effectId: text('effect_id'),
    /** The effect's rolled strength as a position in its range, 0…1 (ticket 3.2). */
    effectRoll: doublePrecision('effect_roll'),
    /** Set id for set pieces (ticket 3.3). */
    setId: text('set_id'),
    /** Named Mythic item id (ticket 3.2). */
    mythicId: text('mythic_id'),
    /** Locked items can't be sold, salvaged or discarded (ticket 3.7). */
    locked: boolean('locked').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('item_instances_character_id_idx').on(t.characterId),
    uniqueIndex('item_instances_equipped_slot_key')
      .on(t.characterId, t.equippedSlot)
      .where(sql`${t.equippedSlot} is not null`),
    check('item_instances_item_level_check', sql`${t.itemLevel} >= 1`),
    check(
      'item_instances_upgrade_level_check',
      sql`${t.upgradeLevel} >= 0 and ${t.upgradeLevel} <= 10`,
    ),
    check(
      'item_instances_forge_counters_check',
      sql`${t.upgradePity} >= 0 and ${t.forgeCounter} >= 0 and ${t.rerollCount} >= 0`,
    ),
    check('item_instances_variant_check', sql`${t.variant} is null or ${t.variant} in ('void')`),
    check(
      'item_instances_effect_roll_check',
      sql`${t.effectRoll} is null or (${t.effectRoll} >= 0 and ${t.effectRoll} <= 1)`,
    ),
  ],
);

/** One item summarised for the return summary (the full row lives in `item_instances`). */
export interface ActivitySummaryItem {
  id: string;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  /** Legendary effect / Mythic signature and named Mythic (ticket 3.2); absent on others. */
  effectId?: string;
  mythicId?: string;
  /** The set of a set piece (ticket 3.3); absent on others. */
  setId?: string;
  /** Ticket 3.5: the variant of a Void item; absent on others. */
  variant?: ItemVariantId;
}

/** See `characters.farmState` and docs/FARMING.md. */
export interface FarmState {
  seedSecret: string;
  /** Cycles completed with this secret (the next cycle's RNG index). */
  cycleIndex: number;
  /** Health after the last completed cycle; null = full. */
  health: number | null;
  /** Bloodrush stacks after the last completed cycle (ticket 3.2); absent = 0. */
  momentum?: number;
  /**
   * Area of the cycle that was in progress when the activity ended (ticket 2.2). The next start
   * replays that cycle there before travelling on, so stop → start elsewhere cannot re-roll it.
   * Absent when the activity ended between cycles.
   */
  areaId?: AreaId;
}

/**
 * Rewards accumulated since the client last collected the summary (ticket 1.6). Scheduled
 * settlements add to it; the client's settle call returns it and starts a new one.
 */
export interface ActivitySummary {
  /** ISO time the summary started (the previous client settle). */
  since: string;
  settlements: number;
  simulatedMs: number;
  /** Time beyond the offline cap that earned nothing. */
  cappedMs: number;
  kills: number;
  deaths: number;
  xpGained: number;
  levelsGained: number;
  goldGained: number;
  /** Part of `goldGained` that came from salvaging items that did not fit the inventory. */
  goldSalvaged: number;
  itemsGained: number;
  itemsSalvaged: number;
  /** The most recent gained items (at most 100). */
  items: ActivitySummaryItem[];
  /** Materials gained (ticket 2.3). Absent in summaries written before 2.3. */
  materials?: Partial<Record<MaterialId, number>>;
  /** Profession XP and level-ups (ticket 2.3). Absent in summaries written before 2.3. */
  professions?: Partial<Record<ProfessionId, { xpGained: number; levelsGained: number }>>;
  /**
   * Ticket 3.7: drops the loot filter sold or salvaged. Their gold is part of `goldGained`, their
   * materials are not part of `materials` (gathering). Absent while nothing was filtered.
   */
  filtered?: LootFilterSummary;
}

/** What the loot filter did with new drops (ticket 3.7). */
export interface LootFilterSummary {
  sold: number;
  salvaged: number;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
}

/**
 * The character's current activity (ticket 1.6, GDD §9). At most one per character and one per
 * account. Progress is settled from server time only; see docs/FARMING.md.
 */
export const activities = pgTable(
  'activities',
  {
    characterId: uuid('character_id')
      .primaryKey()
      .references(() => characters.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** game-core `AreaId`. */
    areaId: text('area_id').$type<AreaId>().notNull(),
    /**
     * Area switch requested while a cycle was in progress (ticket 2.2): that cycle finishes in
     * `area_id`, then the settlement moves the activity here. Null = none.
     */
    pendingAreaId: text('pending_area_id').$type<AreaId>(),
    /**
     * Random secret (per character, carried over via `characters.farm_state`). Cycle `i` draws from
     * `${seedSecret}:${i}` (combat) and `${seedSecret}:loot:${i}` (loot). Never sent to clients.
     */
    seedSecret: text('seed_secret').notNull(),
    /** Settlements that credited time (audit/debugging; not part of the seed since ticket 1.9). */
    settlementSeq: integer('settlement_seq').notNull().default(0),
    /** Cycles completed with `seedSecret`: the RNG index of the next cycle (ticket 1.9). */
    cycleIndex: bigint('cycle_index', { mode: 'number' }).notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** Progress has been computed up to this server time. */
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    /** Last client contact; offline progress accrues until `last_seen_at + OFFLINE_CAP_SECONDS`. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    /** `unusedMs` from the last settlement, credited to the next one. */
    carryMs: integer('carry_ms').notNull().default(0),
    /** Current health between settlements; null = full. */
    health: integer('health'),
    /**
     * Bloodrush stacks after the last completed cycle (ticket 3.2): a kill streak carries across
     * settlements like health, so how often the client settles cannot change it.
     */
    momentum: integer('momentum').notNull().default(0),
    summary: jsonb('summary').$type<ActivitySummary>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('activities_account_id_key').on(t.accountId),
    index('activities_settled_at_idx').on(t.settledAt),
    check('activities_carry_ms_check', sql`${t.carryMs} >= 0`),
    check('activities_settlement_seq_check', sql`${t.settlementSeq} >= 0`),
    check('activities_cycle_index_check', sql`${t.cycleIndex} >= 0`),
    check('activities_momentum_check', sql`${t.momentum} >= 0`),
  ],
);

/**
 * Materials a character holds (ticket 2.3). One row per material with a quantity; materials stack
 * and have no capacity limit for now. Written only by the server (settlement; later the forge).
 */
export const characterMaterials = pgTable(
  'character_materials',
  {
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** game-core `MaterialId`. */
    materialId: text('material_id').$type<MaterialId>().notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.characterId, t.materialId] }),
    check('character_materials_quantity_check', sql`${t.quantity} >= 0`),
  ],
);

/**
 * Gathering profession progress per character (ticket 2.3, game-core `ProfessionState`). A missing
 * row means level 1 with 0 XP. Written only by settlement, under the character lock.
 */
export const characterProfessions = pgTable(
  'character_professions',
  {
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** game-core `ProfessionId`. */
    professionId: text('profession_id').$type<ProfessionId>().notNull(),
    level: integer('level').notNull().default(1),
    /** Experience within the current level. */
    experience: bigint('experience', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.characterId, t.professionId] }),
    check('character_professions_level_check', sql`${t.level} >= 1`),
    check('character_professions_experience_check', sql`${t.experience} >= 0`),
  ],
);

/** Quest kinds (ticket 2.4): the story chain or a repeatable daily contract. */
export type QuestKind = 'story' | 'contract';
/** `active` until turned in; completion is derived from `progress` vs the objectives. */
export type QuestStatus = 'active' | 'turnedIn';

/**
 * Quests a character accepted (ticket 2.4, docs/QUESTS.md). Objectives and rewards are copied from
 * game-core at acceptance, so a content change never alters an accepted quest. Progress is written
 * only by the server from settlement and dungeon events, under the character lock.
 */
export const characterQuests = pgTable(
  'character_quests',
  {
    id: uuid('id').primaryKey(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<QuestKind>().notNull(),
    /** game-core `StoryQuestId`, or the `ContractTemplate` id for contracts. */
    questId: text('quest_id').notNull(),
    /** Contracts: the UTC day (`YYYY-MM-DD`) and board slot they were posted in. */
    contractDay: text('contract_day'),
    contractSlot: smallint('contract_slot'),
    objectives: jsonb('objectives').$type<QuestObjective[]>().notNull(),
    /** Progress per objective (same order), capped at each target. */
    progress: jsonb('progress').$type<number[]>().notNull(),
    reward: jsonb('reward').$type<QuestReward>().notNull(),
    status: text('status').$type<QuestStatus>().notNull().default('active'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    turnedInAt: timestamp('turned_in_at', { withTimezone: true }),
  },
  (t) => [
    index('character_quests_character_id_status_idx').on(t.characterId, t.status),
    // A story quest can be accepted once per character.
    uniqueIndex('character_quests_story_key')
      .on(t.characterId, t.questId)
      .where(sql`${t.kind} = 'story'`),
    // A contract slot can be accepted once per day.
    uniqueIndex('character_quests_contract_slot_key')
      .on(t.characterId, t.contractDay, t.contractSlot)
      .where(sql`${t.kind} = 'contract'`),
    check('character_quests_kind_check', sql`${t.kind} in ('story', 'contract')`),
    check('character_quests_status_check', sql`${t.status} in ('active', 'turnedIn')`),
    check(
      'character_quests_turned_in_check',
      sql`(${t.status} = 'turnedIn') = (${t.turnedInAt} is not null)`,
    ),
    check(
      'character_quests_contract_check',
      sql`(${t.kind} = 'contract') = (${t.contractDay} is not null and ${t.contractSlot} is not null)`,
    ),
  ],
);

/**
 * Stored responses of requests sent with an `Idempotency-Key` header (ticket 2.6,
 * docs/API_CONVENTIONS.md). The row is claimed in the same transaction as the mutation, so a
 * concurrent request with the same key waits on the unique key and then replays the response.
 * Only successful responses are stored (a failed request changed nothing and may be retried).
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The client's key (a UUID by convention; any 8–128 visible ASCII characters). */
    key: text('key').notNull(),
    /** SHA-256 of method, path and canonical JSON body. */
    requestHash: text('request_hash').notNull(),
    statusCode: smallint('status_code').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    ...timestamps,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.key] }),
    index('idempotency_keys_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * Merchant offers a character bought (ticket 2.6). Each daily offer sells once: the primary key
 * is the state guard that keeps a lost idempotency record from selling an offer twice.
 */
export const merchantPurchases = pgTable(
  'merchant_purchases',
  {
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** game-core offer id `<day>.<areaId>.<index>`. */
    offerId: text('offer_id').notNull(),
    /** The item created by the purchase (no FK: the item may be sold or salvaged later). */
    itemId: uuid('item_id').notNull(),
    price: bigint('price', { mode: 'number' }).notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.characterId, t.offerId] }),
    check('merchant_purchases_price_check', sql`${t.price} >= 0`),
  ],
);

/** Character snapshot a dungeon run is played with (ticket 2.5); taken at the run's start. */
export interface DungeonRunSnapshot {
  classId: ClassId;
  level: number;
  xp: number;
  equipment: {
    baseId: string;
    rarityId: RarityId;
    itemLevel: number;
    affixes: RolledAffix[];
    /** Ticket 3.2; absent in snapshots taken before it (those runs replay without effects). */
    effectId?: string | null;
    effectRoll?: number | null;
    /** Ticket 3.3; absent in snapshots taken before it (those runs replay without set bonuses). */
    setId?: string | null;
    /** Ticket 3.4; absent in snapshots taken before it (those runs replay at +0). */
    upgradeLevel?: number;
    /** Ticket 3.5; absent in snapshots taken before it (those runs replay without Void). */
    variant?: ItemVariantId | null;
  }[];
}

/**
 * Dungeon runs (ticket 2.5, docs/DUNGEONS.md). A run is fully determined by `seed_secret` and
 * `snapshot` at the start; the server reveals it as time passes and grants its result once, at the
 * claim. At most one unclaimed run per account (it also blocks farming). Claimed rows stay as
 * history: the boss-loot cooldown is read from them.
 */
export const dungeonRuns = pgTable(
  'dungeon_runs',
  {
    id: uuid('id').primaryKey(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** game-core `DungeonId`. */
    dungeonId: text('dungeon_id').$type<DungeonId>().notNull(),
    /** game-core `DungeonTier` (ticket 3.6); rows from before it are tier I. */
    tier: smallint('tier').$type<DungeonTier>().notNull().default(1),
    /** Random secret of this run. Never sent to clients. */
    seedSecret: text('seed_secret').notNull(),
    snapshot: jsonb('snapshot').$type<DungeonRunSnapshot>().notNull(),
    /** Boss loot was off cooldown at the start (decided then, so the run is fixed). */
    bossLootEligible: boolean('boss_loot_eligible').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** When the result is ready (`started_at` + the run's duration). */
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** `cleared` / `failed`, set at the claim. */
    outcome: text('outcome').$type<'cleared' | 'failed'>(),
    /** Whether the claim granted boss loot (drives the cooldown). */
    bossLootGranted: boolean('boss_loot_granted').notNull().default(false),
    /** The claim's result view, for display after the claim. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('dungeon_runs_account_open_key')
      .on(t.accountId)
      .where(sql`${t.claimedAt} is null`),
    index('dungeon_runs_character_id_started_at_idx').on(t.characterId, t.startedAt),
    check('dungeon_runs_ends_at_check', sql`${t.endsAt} >= ${t.startedAt}`),
    check('dungeon_runs_tier_check', sql`${t.tier} between 1 and 3`),
  ],
);

/** Append-only record of security-relevant and valuable events. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    /** Nullable: e.g. a failed login for an unknown email has no account. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    characterId: uuid('character_id').references(() => characters.id, { onDelete: 'set null' }),
    event: text('event').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index('audit_log_account_id_created_at_idx').on(t.accountId, t.createdAt),
    index('audit_log_event_created_at_idx').on(t.event, t.createdAt),
  ],
);

/**
 * Daily telemetry rollups (ticket 3.8, docs/TELEMETRY.md): server-side aggregate counters only.
 * One row per game-clock day (UTC), metric and up to three content-id dimensions; `events` counts
 * occurrences and `amount` sums a quantity (gold, items, materials, XP). Written only by the
 * per-transaction recorder (`src/telemetry/record.ts`), in the same transaction as the audit row
 * it mirrors. Never holds account, character or item ids, names, emails or IPs.
 */
export const telemetryDaily = pgTable(
  'telemetry_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    dim1: text('dim1').notNull().default(''),
    dim2: text('dim2').notNull().default(''),
    dim3: text('dim3').notNull().default(''),
    events: bigint('events', { mode: 'number' }).notNull().default(0),
    amount: bigint('amount', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.metric, t.dim1, t.dim2, t.dim3] }),
    check('telemetry_daily_events_check', sql`${t.events} >= 0`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type TelemetryDailyRow = typeof telemetryDaily.$inferSelect;
export type ItemInstance = typeof itemInstances.$inferSelect;
export type NewItemInstance = typeof itemInstances.$inferInsert;
export type CharacterMaterial = typeof characterMaterials.$inferSelect;
export type CharacterProfession = typeof characterProfessions.$inferSelect;
export type CharacterQuest = typeof characterQuests.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type MerchantPurchase = typeof merchantPurchases.$inferSelect;
export type DungeonRun = typeof dungeonRuns.$inferSelect;
