import { eq } from 'drizzle-orm';
import {
  PROFILE_FIELD_IDS,
  REPORT_TARGET_KINDS,
  HANDLE_RE,
  type ReportTarget,
  type ReportTargetKind,
} from '@worldforge/game-core';
import { accounts, type Account } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/**
 * Report target registry (ticket 4.1, docs/SOCIAL.md "Reports"). Each kind of game-core
 * `ReportTarget` registers how to find the account it belongs to (the subject), its internal key
 * (one open report per reporter and key; a `hide` sanction hides a key) and the context snapshot
 * stored with the report. Later tickets add a resolver for each new kind (guild, message) and a
 * branch in `reportTargetSchema`.
 */
export interface ResolvedTarget {
  subject: Account;
  /** Internal, never sent to players: `player:<account id>`, `profileField:<account id>:<field>`. */
  key: string;
  /** The canonical public target (handles only). */
  target: ReportTarget;
  /** What the reporter saw, kept as evidence. */
  context: Record<string, unknown>;
}

type Resolver<K extends ReportTargetKind> = (
  executor: Executor,
  target: Extract<ReportTarget, { kind: K }>,
) => Promise<ResolvedTarget | null>;

async function accountByHandle(executor: Executor, handle: string): Promise<Account | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const [row] = await executor.select().from(accounts).where(eq(accounts.handle, handle)).limit(1);
  return row ?? null;
}

const RESOLVERS: { [K in ReportTargetKind]: Resolver<K> } = {
  player: async (executor, t) => {
    const subject = await accountByHandle(executor, t.handle);
    if (!subject) return null;
    return {
      subject,
      key: `player:${subject.id}`,
      target: { kind: 'player', handle: subject.handle },
      context: { displayName: subject.displayName },
    };
  },
  profileField: async (executor, t) => {
    const subject = await accountByHandle(executor, t.handle);
    if (!subject) return null;
    return {
      subject,
      key: profileFieldKey(subject.id, t.field),
      target: { kind: 'profileField', handle: subject.handle, field: t.field },
      context: { displayName: subject.displayName, value: subject.displayName },
    };
  },
};

export function profileFieldKey(accountId: string, field: string): string {
  return `profileField:${accountId}:${field}`;
}

export function resolveReportTarget(
  executor: Executor,
  target: ReportTarget,
): Promise<ResolvedTarget | null> {
  const resolver = RESOLVERS[target.kind] as Resolver<ReportTargetKind>;
  return resolver(executor, target as never);
}

export function isHideable(kind: ReportTargetKind): boolean {
  return REPORT_TARGET_KINDS[kind].hideable;
}

const handleSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;

/** JSON Schema for a `ReportTarget` in request bodies. */
export const reportTargetSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'handle'],
      properties: { kind: { const: 'player' }, handle: handleSchema },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'handle', 'field'],
      properties: {
        kind: { const: 'profileField' },
        handle: handleSchema,
        field: { type: 'string', enum: [...PROFILE_FIELD_IDS] },
      },
    },
  ],
} as const;

export const reportTargetViewSchema = {
  type: 'object',
  required: ['kind', 'handle'],
  properties: { kind: { type: 'string' }, handle: { type: 'string' }, field: { type: 'string' } },
} as const;
