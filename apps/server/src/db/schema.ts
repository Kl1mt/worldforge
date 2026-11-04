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
import type { CharacterAppearance, ClassId } from '@worldforge/game-core';

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
