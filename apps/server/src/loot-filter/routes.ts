import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  LOOT_FILTER_ACTIONS,
  LOOT_FILTER_AFFIX_IDS,
  LOOT_FILTER_CATEGORIES,
  LOOT_FILTER_EFFECT_IDS,
  LOOT_FILTER_MAX_WANTED,
  RARITY_IDS,
  isLootFilterActive,
  parseLootFilter,
  type LootFilterRules,
} from '@worldforge/game-core';
import { characters } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import {
  characterNotFound,
  characterParamsSchema,
  lockOwnedCharacter,
} from '../inventory/routes.js';

/**
 * Loot filter rules (ticket 3.7, docs/LOOT.md "Loot filter"). One set of rules per character in
 * `characters.loot_filter`. Settlement and the crypt claim read it under the character lock and
 * apply it to new drops only.
 *
 * A change settles the running activity first, with the old rules (like an equipment change,
 * ticket 1.9): every committed cycle up to now is filtered by the rules that were in force, and
 * only later drops see the new ones. Both writes run under the character lock, so a settlement
 * racing the change sees either the old rules (and settles first) or the new ones (and has nothing
 * old left to settle). Setting the same rules again changes nothing, so no `Idempotency-Key`.
 */

export interface LootFilterResponse {
  characterId: string;
  /** Null = no filter. */
  rules: LootFilterRules | null;
  /** Whether the rules can handle any drop at all. */
  active: boolean;
}

const rulesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'belowRarity', 'wantedAffixes', 'wantedEffects', 'include'],
  properties: {
    action: { type: 'string', enum: [...LOOT_FILTER_ACTIONS] },
    belowRarity: { type: ['string', 'null'], enum: [...RARITY_IDS, null] },
    wantedAffixes: {
      type: 'array',
      maxItems: LOOT_FILTER_MAX_WANTED,
      uniqueItems: true,
      items: { type: 'string', enum: [...LOOT_FILTER_AFFIX_IDS] },
    },
    wantedEffects: {
      type: 'array',
      maxItems: LOOT_FILTER_MAX_WANTED,
      uniqueItems: true,
      items: { type: 'string', enum: [...LOOT_FILTER_EFFECT_IDS] },
    },
    include: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: [...LOOT_FILTER_CATEGORIES] },
    },
  },
} as const;

const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: { rules: { anyOf: [{ type: 'null' }, rulesSchema] } },
} as const;

const responseSchema = {
  type: 'object',
  required: ['characterId', 'rules', 'active'],
  properties: {
    characterId: { type: 'string' },
    rules: { anyOf: [{ type: 'null' }, rulesSchema] },
    active: { type: 'boolean' },
  },
} as const;

/** Rules in a fixed key order (jsonb does not keep the order they were written in). */
function canonical(rules: LootFilterRules | null): string {
  if (!rules) return 'null';
  const { action, belowRarity, wantedAffixes, wantedEffects, include } = rules;
  return JSON.stringify([action, belowRarity, wantedAffixes, wantedEffects, include]);
}

function view(characterId: string, rules: LootFilterRules | null): LootFilterResponse {
  return { characterId, rules, active: isLootFilterActive(rules) };
}

export async function registerLootFilter(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/loot-filter',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, response: { 200: responseSchema } },
    },
    async (request): Promise<LootFilterResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const [row] = await app.db
        .select({ lootFilter: characters.lootFilter })
        .from(characters)
        .where(
          and(
            eq(characters.id, characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        );
      if (!row) throw characterNotFound();
      return view(characterId, row.lootFilter ?? null);
    },
  );

  app.post<{ Params: { characterId: string }; Body: { rules: unknown } }>(
    '/characters/:characterId/loot-filter',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: bodySchema,
        response: { 200: responseSchema },
      },
    },
    async (request): Promise<LootFilterResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      let rules: LootFilterRules | null = null;
      if (request.body.rules !== null) {
        const parsed = parseLootFilter(request.body.rules);
        if (!parsed.ok) {
          throw new ApiError(400, 'validation_failed', 'Invalid loot filter rules.', {
            problems: parsed.problems,
          });
        }
        rules = parsed.rules;
      }
      return withTransaction(app.db, async (tx) => {
        // Locks the character and settles with the rules in force until now.
        const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
        const before = character.lootFilter ?? null;
        if (canonical(before) !== canonical(rules)) {
          await tx
            .update(characters)
            .set({ lootFilter: rules, updatedAt: activity.now() })
            .where(eq(characters.id, characterId));
          await writeAudit(tx, {
            event: 'loot_filter.update',
            accountId,
            characterId,
            data: { before, after: rules },
          });
        }
        return view(characterId, rules);
      });
    },
  );
}
