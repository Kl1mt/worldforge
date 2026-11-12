import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  LOOT_FILTER_ACTIONS,
  LOOT_FILTER_AFFIX_IDS,
  LOOT_FILTER_CATEGORIES,
  LOOT_FILTER_EFFECT_IDS,
  LOOT_FILTER_MAX_WANTED,
  RARITY_IDS,
  LOOT_FILTER_PRESET_LIMIT,
  LOOT_FILTER_PRESET_NAME_MAX,
  LOOT_FILTER_CODE_MAX_LENGTH,
  decodeLootFilterCode,
  isLootFilterActive,
  normalisePresetName,
  parseLootFilter,
  type LootFilterPreset,
  type LootFilterRules,
} from '@worldforge/game-core';
import { characters } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Transaction } from '../db/types.js';
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

export interface LootFilterPresetView {
  slot: number;
  name: string;
  rules: LootFilterRules | null;
  active: boolean;
}

export interface LootFilterResponse {
  characterId: string;
  /** Null = no filter. */
  rules: LootFilterRules | null;
  /** Whether the rules can handle any drop at all. */
  active: boolean;
  /** Ticket 8.5: the hero's saved presets, in slot order. */
  presets: LootFilterPresetView[];
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

const codeSchema = {
  type: 'string',
  minLength: 1,
  maxLength: LOOT_FILTER_CODE_MAX_LENGTH,
} as const;
const slotSchema = { type: 'integer', minimum: 0, maximum: LOOT_FILTER_PRESET_LIMIT - 1 } as const;
const nameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: LOOT_FILTER_PRESET_NAME_MAX * 4,
} as const;

/** Exactly one source of rules: the rules, a share code (8.5) or a saved preset (8.5). */
const bodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rules: { anyOf: [{ type: 'null' }, rulesSchema] },
    code: codeSchema,
    preset: slotSchema,
  },
  oneOf: [{ required: ['rules'] }, { required: ['code'] }, { required: ['preset'] }],
} as const;

const presetBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slot', 'name'],
  properties: {
    slot: slotSchema,
    name: nameSchema,
    rules: { anyOf: [{ type: 'null' }, rulesSchema] },
    code: codeSchema,
  },
  oneOf: [{ required: ['rules'] }, { required: ['code'] }],
} as const;

const renameBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: nameSchema, from: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

const decodeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: { code: codeSchema },
} as const;

const presetParamsSchema = {
  type: 'object',
  required: ['characterId', 'slot'],
  properties: {
    characterId: characterParamsSchema.properties.characterId,
    slot: slotSchema,
  },
} as const;

const responseSchema = {
  type: 'object',
  required: ['characterId', 'rules', 'active', 'presets'],
  properties: {
    characterId: { type: 'string' },
    rules: { anyOf: [{ type: 'null' }, rulesSchema] },
    active: { type: 'boolean' },
    presets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slot', 'name', 'rules', 'active'],
        properties: {
          slot: { type: 'integer' },
          name: { type: 'string' },
          rules: { anyOf: [{ type: 'null' }, rulesSchema] },
          active: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/** Rules in a fixed key order (jsonb does not keep the order they were written in). */
function canonical(rules: LootFilterRules | null): string {
  if (!rules) return 'null';
  const { action, belowRarity, wantedAffixes, wantedEffects, include } = rules;
  return JSON.stringify([action, belowRarity, wantedAffixes, wantedEffects, include]);
}

function view(
  characterId: string,
  rules: LootFilterRules | null,
  presets: readonly LootFilterPreset[],
): LootFilterResponse {
  return {
    characterId,
    rules,
    active: isLootFilterActive(rules),
    presets: presets.map((p, slot) => ({
      slot,
      name: p.name,
      rules: p.rules,
      active: isLootFilterActive(p.rules),
    })),
  };
}

function invalidRules(problems: unknown): ApiError {
  return new ApiError(400, 'validation_failed', 'Invalid loot filter rules.', { problems });
}

/**
 * The rules a body names, validated here whatever the client showed: plain rules through
 * `parseLootFilter`, a share code through `decodeLootFilterCode` (which ends in the same parser).
 */
export function rulesFromBody(body: { rules?: unknown; code?: unknown }): LootFilterRules | null {
  if (body.code !== undefined) {
    const decoded = decodeLootFilterCode(body.code);
    if (!decoded.ok) {
      throw new ApiError(400, 'invalid_filter_code', 'That share code cannot be read.', {
        reason: decoded.error,
        ...(decoded.problems ? { problems: decoded.problems } : {}),
      });
    }
    return decoded.rules;
  }
  if (body.rules === null || body.rules === undefined) return null;
  const parsed = parseLootFilter(body.rules);
  if (!parsed.ok) throw invalidRules(parsed.problems);
  return parsed.rules;
}

function presetName(input: unknown): string {
  const name = normalisePresetName(input);
  if (name === null) {
    throw new ApiError(400, 'validation_failed', 'Give the preset a name of 1–24 characters.', {
      fields: { name: `1–${LOOT_FILTER_PRESET_NAME_MAX} characters, no control characters.` },
    });
  }
  return name;
}

function storedPresets(row: { lootFilterPresets: LootFilterPreset[] | null }): LootFilterPreset[] {
  return Array.isArray(row.lootFilterPresets) ? row.lootFilterPresets : [];
}

/** Locks the hero's row (no settlement: a preset never touches the filter in force). */
async function lockPresets(tx: Transaction, accountId: string, characterId: string) {
  const [row] = await tx
    .select({ lootFilter: characters.lootFilter, lootFilterPresets: characters.lootFilterPresets })
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.accountId, accountId),
        isNull(characters.deletedAt),
      ),
    )
    .for('no key update');
  if (!row) throw characterNotFound();
  return { rules: row.lootFilter ?? null, presets: storedPresets(row) };
}

function presetNotFound(): ApiError {
  return new ApiError(404, 'preset_not_found', 'There is no preset in that slot.');
}

/** Ticket 8.7: the slot holds another preset than the one meant (the list changed meanwhile). */
function presetChanged(): ApiError {
  return new ApiError(
    409,
    'preset_changed',
    'Your presets changed in the meantime. Look at the list again and try once more.',
  );
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
        .select({
          lootFilter: characters.lootFilter,
          lootFilterPresets: characters.lootFilterPresets,
        })
        .from(characters)
        .where(
          and(
            eq(characters.id, characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        );
      if (!row) throw characterNotFound();
      return view(characterId, row.lootFilter ?? null, storedPresets(row));
    },
  );

  app.post<{
    Params: { characterId: string };
    Body: { rules?: unknown; code?: string; preset?: number };
  }>(
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
      const { preset } = request.body;
      // Rules and codes are validated before the transaction; a preset is read under the lock.
      const given = preset === undefined ? rulesFromBody(request.body) : undefined;
      return withTransaction(app.db, async (tx) => {
        // Locks the character and settles with the rules in force until now.
        const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
        const presets = storedPresets(character);
        let rules: LootFilterRules | null;
        if (preset !== undefined) {
          const chosen = presets[preset];
          if (!chosen) throw presetNotFound();
          // Stored presets were validated when saved; re-check against today's content anyway.
          rules = rulesFromBody({ rules: chosen.rules });
        } else {
          rules = given!;
        }
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
            data: {
              before,
              after: rules,
              ...(preset !== undefined ? { preset } : {}),
              ...(request.body.code !== undefined ? { via: 'code' } : {}),
            },
          });
        }
        return view(characterId, rules, presets);
      });
    },
  );

  // Ticket 8.5: a share code read back for the import preview, by the server's own decoder.
  app.post<{ Params: { characterId: string }; Body: { code: string } }>(
    '/characters/:characterId/loot-filter/decode',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, body: decodeBodySchema },
    },
    async (request) => {
      // Ticket 8.7: like every hero route, another account's (or an unknown) hero is a 404.
      const [own] = await app.db
        .select({ id: characters.id })
        .from(characters)
        .where(
          and(
            eq(characters.id, request.params.characterId),
            eq(characters.accountId, request.auth!.account.id),
            isNull(characters.deletedAt),
          ),
        );
      if (!own) throw characterNotFound();
      const rules = rulesFromBody({ code: request.body.code });
      return { rules, active: isLootFilterActive(rules) };
    },
  );

  // Ticket 8.5: save (or overwrite) a preset. The rules in force are not changed.
  app.post<{
    Params: { characterId: string };
    Body: { slot: number; name: string; rules?: unknown; code?: string };
  }>(
    '/characters/:characterId/loot-filter/presets',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: presetBodySchema,
        response: { 200: responseSchema },
      },
    },
    async (request): Promise<LootFilterResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { slot } = request.body;
      const name = presetName(request.body.name);
      const rules = rulesFromBody(request.body);
      return withTransaction(app.db, async (tx) => {
        const held = await lockPresets(tx, accountId, characterId);
        if (slot > held.presets.length) {
          throw new ApiError(422, 'preset_slot_gap', 'Save into the next free slot.', {
            next: held.presets.length,
          });
        }
        const before = held.presets[slot] ?? null;
        const presets = [...held.presets];
        presets[slot] = { name, rules };
        if (JSON.stringify(before) !== JSON.stringify(presets[slot])) {
          await tx
            .update(characters)
            .set({ lootFilterPresets: presets, updatedAt: activity.now() })
            .where(eq(characters.id, characterId));
          await writeAudit(tx, {
            event: 'loot_filter.preset',
            accountId,
            characterId,
            data: { action: before ? 'overwrite' : 'save', slot, name, rules },
          });
        }
        return view(characterId, held.rules, presets);
      });
    },
  );

  app.post<{
    Params: { characterId: string; slot: number };
    Body: { name: string; from?: string };
  }>(
    '/characters/:characterId/loot-filter/presets/:slot/rename',
    {
      preHandler: app.requireAccount,
      schema: {
        params: presetParamsSchema,
        body: renameBodySchema,
        response: { 200: responseSchema },
      },
    },
    async (request): Promise<LootFilterResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId, slot } = request.params;
      const name = presetName(request.body.name);
      return withTransaction(app.db, async (tx) => {
        const held = await lockPresets(tx, accountId, characterId);
        const current = held.presets[slot];
        if (!current) throw presetNotFound();
        // Ticket 8.7: `from` names the preset meant (another tab may have moved the slots).
        if (request.body.from !== undefined && current.name !== request.body.from) {
          throw presetChanged();
        }
        const presets = [...held.presets];
        presets[slot] = { ...current, name };
        if (current.name !== name) {
          await tx
            .update(characters)
            .set({ lootFilterPresets: presets, updatedAt: activity.now() })
            .where(eq(characters.id, characterId));
          await writeAudit(tx, {
            event: 'loot_filter.preset',
            accountId,
            characterId,
            data: { action: 'rename', slot, from: current.name, name },
          });
        }
        return view(characterId, held.rules, presets);
      });
    },
  );

  app.delete<{
    Params: { characterId: string; slot: number };
    Querystring: { name: string };
  }>(
    '/characters/:characterId/loot-filter/presets/:slot',
    {
      preHandler: app.requireAccount,
      schema: {
        params: presetParamsSchema,
        // Ticket 8.7: the delete names the preset it deletes. Deleting moves the later presets
        // up a slot, so a retried delete by slot alone removed the next one.
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: { 200: responseSchema },
      },
    },
    async (request): Promise<LootFilterResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId, slot } = request.params;
      const expected = request.query.name;
      return withTransaction(app.db, async (tx) => {
        const held = await lockPresets(tx, accountId, characterId);
        const current = held.presets[slot];
        if (!current || current.name !== expected) {
          // Repeat-safe by state: a preset already gone changes nothing; one that moved into
          // this slot is not the one meant.
          if (held.presets.some((p) => p.name === expected)) throw presetChanged();
          return view(characterId, held.rules, held.presets);
        }
        const presets = held.presets.filter((_, i) => i !== slot);
        await tx
          .update(characters)
          .set({ lootFilterPresets: presets, updatedAt: activity.now() })
          .where(eq(characters.id, characterId));
        await writeAudit(tx, {
          event: 'loot_filter.preset',
          accountId,
          characterId,
          data: { action: 'delete', slot, name: current.name },
        });
        return view(characterId, held.rules, presets);
      });
    },
  );
}
