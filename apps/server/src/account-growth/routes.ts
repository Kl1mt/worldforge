import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull } from 'drizzle-orm';
import {
  OFFLINE_BONUS_STEPS_MS,
  OFFLINE_RULES,
  SLOT_RULES,
  offlineCapMs,
  type AccountGrowthRule,
} from '@worldforge/game-core';
import { characters } from '../db/schema.js';
import type { ActivityOptions } from '../activity/settle.js';
import { lockedView, loadGrowthGrants } from './grant.js';

/**
 * Ticket 9.4 (docs/ACCOUNTS.md "API"): `GET /api/account/growth`, what the account has earned
 * (character slots and offline hours), what comes next and how to get it. Read-only: grants are
 * made only by the server's own events (and the backfill), never by a request.
 */
export interface GrowthEntry {
  source: string;
  description: string;
  available: boolean;
  /** When it was granted (null: not earned yet). */
  grantedAt: string | null;
}

export interface AccountGrowthResponse {
  slots: {
    base: number;
    total: number;
    used: number;
    /** Every earnable slot, in order, then any granted by another source (the later shop). */
    entries: GrowthEntry[];
  };
  offline: {
    baseMs: number;
    /** The cap in force now (base plus every step earned). */
    capMs: number;
    /** The cap after the next deed (null at the top). */
    nextCapMs: number | null;
    /** The cap at each step, from none to every deed earned. */
    stepsMs: number[];
    deeds: GrowthEntry[];
  };
}

const entrySchema = {
  type: 'object',
  required: ['source', 'description', 'available', 'grantedAt'],
  properties: {
    source: { type: 'string' },
    description: { type: 'string' },
    available: { type: 'boolean' },
    grantedAt: { type: ['string', 'null'] },
  },
} as const;

const responseSchema = {
  type: 'object',
  required: ['slots', 'offline'],
  properties: {
    slots: {
      type: 'object',
      required: ['base', 'total', 'used', 'entries'],
      properties: {
        base: { type: 'integer' },
        total: { type: 'integer' },
        used: { type: 'integer' },
        entries: { type: 'array', items: entrySchema },
      },
    },
    offline: {
      type: 'object',
      required: ['baseMs', 'capMs', 'nextCapMs', 'stepsMs', 'deeds'],
      properties: {
        baseMs: { type: 'integer' },
        capMs: { type: 'integer' },
        nextCapMs: { type: ['integer', 'null'] },
        stepsMs: { type: 'array', items: { type: 'integer' } },
        deeds: { type: 'array', items: entrySchema },
      },
    },
  },
} as const;

/** The account's current offline cap (base plus its earned steps), for the activity view. */
export async function accountOfflineCapMs(
  app: FastifyInstance,
  accountId: string,
  baseMs: number,
): Promise<number> {
  const grants = await loadGrowthGrants(app.db, accountId);
  return offlineCapMs(baseMs, grants.filter((g) => g.kind === 'offline').length);
}

export async function registerAccountGrowth(
  app: FastifyInstance,
  options: Pick<ActivityOptions, 'offlineCapMs'>,
): Promise<void> {
  app.get(
    '/account/growth',
    { preHandler: app.requireAccount, schema: { response: { 200: responseSchema } } },
    async (request): Promise<AccountGrowthResponse> => {
      const { account } = request.auth!;
      const [grants, [used]] = await Promise.all([
        loadGrowthGrants(app.db, account.id),
        app.db
          .select({ n: count() })
          .from(characters)
          .where(and(eq(characters.accountId, account.id), isNull(characters.deletedAt))),
      ]);
      const byId = new Map(grants.map((g) => [g.grantId, g]));
      const entry = (rule: AccountGrowthRule): GrowthEntry => ({
        ...lockedView(rule),
        grantedAt: byId.get(rule.id)?.grantedAt.toISOString() ?? null,
      });
      const ruleIds = new Set<string>([...SLOT_RULES, ...OFFLINE_RULES].map((r) => r.id));
      const otherSlots: GrowthEntry[] = grants
        .filter((g) => g.kind === 'slot' && !ruleIds.has(g.grantId))
        .map((g) => ({
          source: g.source,
          description: '',
          available: true,
          grantedAt: g.grantedAt.toISOString(),
        }));
      const slotGrants = grants.filter((g) => g.kind === 'slot').length;
      const deeds = grants.filter((g) => g.kind === 'offline').length;
      const base = options.offlineCapMs;
      const stepsMs = OFFLINE_BONUS_STEPS_MS.map((b) => base + b);
      return {
        slots: {
          base: account.characterSlots,
          total: account.characterSlots + slotGrants,
          used: used?.n ?? 0,
          entries: [...SLOT_RULES.map(entry), ...otherSlots],
        },
        offline: {
          baseMs: base,
          capMs: offlineCapMs(base, deeds),
          nextCapMs: deeds + 1 < stepsMs.length ? offlineCapMs(base, deeds + 1) : null,
          stepsMs,
          deeds: OFFLINE_RULES.map(entry),
        },
      };
    },
  );
}
