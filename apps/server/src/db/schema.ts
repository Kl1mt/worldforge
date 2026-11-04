import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** Append-only record of security-relevant and valuable events. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    /** Nullable: e.g. a failed login for an unknown email has no account. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** FK added once the characters table exists (ticket 1.3). */
    characterId: uuid('character_id'),
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
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
