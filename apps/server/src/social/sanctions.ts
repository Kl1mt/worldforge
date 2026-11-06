import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { ReportTarget, SanctionKind } from '@worldforge/game-core';
import { sanctions, type Sanction } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { ApiError } from '../errors.js';

/** A sanction as its subject sees it (`GET /api/account/standing`, the 403 bodies). No issuer. */
export interface SanctionView {
  id: string;
  kind: SanctionKind;
  reason: string;
  createdAt: string;
  expiresAt: string;
  /** The hidden content, for `hide`. */
  target: ReportTarget | null;
}

export function sanctionView(s: Sanction): SanctionView {
  return {
    id: s.id,
    kind: s.kind,
    reason: s.reason,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    target: s.target ?? null,
  };
}

export const sanctionViewSchema = {
  type: 'object',
  required: ['id', 'kind', 'reason', 'createdAt', 'expiresAt', 'target'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    reason: { type: 'string' },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    target: {
      type: ['object', 'null'],
      properties: {
        kind: { type: 'string' },
        handle: { type: 'string' },
        field: { type: 'string' },
        name: { type: 'string' },
      },
    },
  },
} as const;

const activeAt = (now: Date) => and(isNull(sanctions.liftedAt), gt(sanctions.expiresAt, now));

/** The account's active sanctions (not lifted, not expired at `now`), oldest first. */
export async function activeSanctions(
  executor: Executor,
  accountId: string,
  now: Date,
  kinds?: SanctionKind[],
): Promise<Sanction[]> {
  return executor
    .select()
    .from(sanctions)
    .where(
      and(
        eq(sanctions.subjectId, accountId),
        activeAt(now),
        kinds ? inArray(sanctions.kind, kinds) : undefined,
      ),
    )
    .orderBy(sanctions.createdAt, sanctions.id);
}

/** The target keys among `keys` that an active `hide` sanction hides from other players. */
export async function hiddenTargetKeys(
  executor: Executor,
  keys: string[],
  now: Date,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await executor
    .select({ key: sanctions.targetKey })
    .from(sanctions)
    .where(and(eq(sanctions.kind, 'hide'), inArray(sanctions.targetKey, keys), activeAt(now)));
  return new Set(rows.map((r) => r.key!));
}

/** `403 account_suspended` or `403 muted`, with the sanction so the player sees why. */
export function sanctionError(s: Sanction): ApiError {
  const sanction = sanctionView(s);
  if (s.kind === 'suspend') {
    return new ApiError(403, 'account_suspended', 'This account is suspended.', { sanction });
  }
  return new ApiError(403, 'muted', 'You are muted and cannot post or reach other players.', {
    sanction,
  });
}
