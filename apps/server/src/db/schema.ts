import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  index,
  jsonb,
  pgTable,
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
  EquipmentSlotId,
  RarityId,
  RolledAffix,
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
    ...timestamps,
  },
  (t) => [
    index('item_instances_character_id_idx').on(t.characterId),
    uniqueIndex('item_instances_equipped_slot_key')
      .on(t.characterId, t.equippedSlot)
      .where(sql`${t.equippedSlot} is not null`),
    check('item_instances_item_level_check', sql`${t.itemLevel} >= 1`),
  ],
);

/** One item summarised for the return summary (the full row lives in `item_instances`). */
export interface ActivitySummaryItem {
  id: string;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
}

/** See `characters.farmState` and docs/FARMING.md. */
export interface FarmState {
  seedSecret: string;
  /** Cycles completed with this secret (the next cycle's RNG index). */
  cycleIndex: number;
  /** Health after the last completed cycle; null = full. */
  health: number | null;
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
    summary: jsonb('summary').$type<ActivitySummary>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('activities_account_id_key').on(t.accountId),
    index('activities_settled_at_idx').on(t.settledAt),
    check('activities_carry_ms_check', sql`${t.carryMs} >= 0`),
    check('activities_settlement_seq_check', sql`${t.settlementSeq} >= 0`),
    check('activities_cycle_index_check', sql`${t.cycleIndex} >= 0`),
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

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type ItemInstance = typeof itemInstances.$inferSelect;
export type NewItemInstance = typeof itemInstances.$inferInsert;
export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
