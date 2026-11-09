import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { ReportTarget, SanctionKind } from '@worldforge/game-core';
import { sanctions, type Sanction } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
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
        id: { type: 'string' },
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

/**
 * What a new sanction is, handed to every `onSanctionIssued` listener (ticket T.4). The seam T.5
 * voids open offers from: a trade restriction or a suspension ends the subject's open offers
 * ("What blocks and sanctions do", docs/TRADING.md). Like T.2's `onSettingsChanged`.
 */
export interface SanctionIssuedEvent {
  sanction: Sanction;
  kind: SanctionKind;
  subjectId: string;
  actorAccountId: string;
  at: Date;
}

/**
 * A listener runs **inside the issuing transaction**, after the sanction row and its
 * `sanction.issue` audit row are written, under the subject's account lock: what it writes
 * commits or rolls back with the sanction, and a throw refuses it.
 */
export type SanctionIssuedListener = (event: SanctionIssuedEvent, tx: Transaction) => Promise<void>;

export class SanctionEvents {
  private readonly listeners: SanctionIssuedListener[] = [];

  onSanctionIssued(listener: SanctionIssuedListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async emit(event: SanctionIssuedEvent, tx: Transaction): Promise<void> {
    for (const l of [...this.listeners]) await l(event, tx);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Ticket T.4: the in-transaction seam for new sanctions (T.5 voids offers from it). */
    sanctionEvents: SanctionEvents;
  }
}
