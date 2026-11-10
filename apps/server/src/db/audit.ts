import { auditLog, type AuditLogEntry } from './schema.js';
import type { Executor } from './types.js';
import { uuidv7 } from './uuid.js';
import { noteTelemetryAccount } from '../telemetry/record.js';

export interface AuditEvent {
  /** Dotted event name, e.g. `account.register`, `auth.login_failed`. */
  event: string;
  accountId?: string | null;
  characterId?: string | null;
  /** Small, non-secret context. Never passwords, tokens or full request bodies. */
  data?: Record<string, unknown>;
}

/**
 * Appends an audit row. Pass the surrounding transaction so the audit entry commits
 * (or rolls back) together with the change it describes.
 */
export async function writeAudit(executor: Executor, entry: AuditEvent): Promise<AuditLogEntry> {
  // Ticket D.4: the transaction's telemetry cohort (test accounts flush to their own table).
  noteTelemetryAccount(executor, entry.accountId);
  const [row] = await executor
    .insert(auditLog)
    .values({
      id: uuidv7(),
      event: entry.event,
      accountId: entry.accountId ?? null,
      characterId: entry.characterId ?? null,
      data: entry.data ?? {},
    })
    .returning();
  return row!;
}
