import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ACTIVE_SKILLS,
  LOADOUT_ACTIVE_SLOTS,
  LOADOUT_PRESETS,
  PASSIVE_SKILLS,
  RESOURCE_RULES,
  defaultLoadout,
  effectiveLoadout,
  isDefaultLoadout,
  loadoutTelemetryKey,
  skillUnlocked,
  validateLoadout,
  type ClassId,
  type Loadout,
} from '@worldforge/game-core';
import { activities, characterLoadouts, characters, type Character } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { recordTelemetry } from '../telemetry/record.js';
import type { ActivityOptions } from '../activity/settle.js';
import {
  characterNotFound,
  characterParamsSchema,
  lockOwnedCharacter,
} from '../inventory/routes.js';
import { canonicalLoadout, heroFacts, loadPresets, sameLoadout } from './store.js';

/**
 * Ticket 9.2: skill loadouts (docs/SKILLS.md "Loadouts", docs/API_CONVENTIONS.md). Three presets
 * per hero in `character_loadouts`, the one in force in `characters.loadout_preset`.
 *
 * Both writes settle the running activity first, under the character lock, with the loadout that
 * was in force (like the loot filter, ticket 3.7): every committed cycle up to now fought with the
 * old loadout, and only later fights see the new one, so a window never mixes two loadouts and
 * nobody switches mid-fight. A crypt run, a guild boss attempt and a duel defence keep the loadout
 * saved with their own snapshot. Saving the same loadout again, or switching to the preset already
 * in force, changes nothing and writes no audit row: idempotent without an `Idempotency-Key`.
 * Validated here whatever the client showed (class, slots, unlocks: level and boss deeds).
 */

export interface SkillsPresetView {
  preset: number;
  actives: (string | null)[];
  passive: string | null;
  /** The default loadout (no row, or one saved equal to it). */
  isDefault: boolean;
  /** Why the stored preset can't be fielded now (it then fights as the default); empty = fine. */
  problems: string[];
}

export interface SkillsResponse {
  characterId: string;
  classId: ClassId;
  level: number;
  resource: { max: number; start: number };
  /** The preset in force (1–3). */
  activePreset: number;
  /** The loadout the hero fights with now (the preset in force, checked). */
  inForce: { actives: (string | null)[]; passive: string | null };
  presets: SkillsPresetView[];
  /** The class's skills this hero has unlocked (ids; locked ones are shown with their unlock). */
  unlocked: string[];
  /** Soul Fragments the last kill left (warlock with a loadout that uses them; 0 otherwise). */
  soulFragments: number;
}

const skillIds = [...ACTIVE_SKILLS.map((s) => s.id)];
const passiveIds = [...PASSIVE_SKILLS.map((s) => s.id)];

const presetSchema = { type: 'integer', minimum: 1, maximum: LOADOUT_PRESETS } as const;

const loadoutBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['actives', 'passive'],
  properties: {
    actives: {
      type: 'array',
      minItems: 1,
      maxItems: LOADOUT_ACTIVE_SLOTS,
      items: { anyOf: [{ type: 'null' }, { type: 'string', enum: skillIds }] },
    },
    passive: { anyOf: [{ type: 'null' }, { type: 'string', enum: passiveIds }] },
  },
} as const;

const presetParamsSchema = {
  type: 'object',
  required: ['characterId', 'preset'],
  properties: {
    characterId: characterParamsSchema.properties.characterId,
    preset: presetSchema,
  },
} as const;

const switchBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['preset'],
  properties: { preset: presetSchema },
} as const;

async function soulFragmentsOf(db: Executor, hero: Character): Promise<number> {
  const [row] = await db
    .select({ n: activities.soulFragments })
    .from(activities)
    .where(eq(activities.characterId, hero.id));
  return row?.n ?? hero.farmState?.soulFragments ?? 0;
}

export async function skillsView(db: Executor, hero: Character): Promise<SkillsResponse> {
  const facts = heroFacts(hero);
  const stored = await loadPresets(db, hero.id);
  const rules = RESOURCE_RULES[hero.classId];
  const presets = stored.map(({ preset, loadout }): SkillsPresetView => {
    const l = canonicalLoadout(hero.classId, loadout);
    return {
      preset,
      actives: [...l.actives],
      passive: l.passive ?? null,
      isDefault: isDefaultLoadout(hero.classId, l),
      problems: validateLoadout(hero.classId, l, facts),
    };
  });
  const active = presets.find((p) => p.preset === hero.loadoutPreset) ?? presets[0]!;
  const inForce = canonicalLoadout(
    hero.classId,
    effectiveLoadout(hero.classId, { actives: active.actives, passive: active.passive }, facts),
  );
  return {
    characterId: hero.id,
    classId: hero.classId,
    level: hero.level,
    resource: { max: rules.max, start: rules.start === 'full' ? rules.max : rules.start },
    activePreset: active.preset,
    inForce: { actives: [...inForce.actives], passive: inForce.passive ?? null },
    presets,
    unlocked: [...ACTIVE_SKILLS, ...PASSIVE_SKILLS]
      .filter((s) => s.classId === hero.classId && skillUnlocked(s, facts))
      .map((s) => s.id),
    soulFragments: await soulFragmentsOf(db, hero),
  };
}

function invalidLoadout(problems: string[]): ApiError {
  return new ApiError(400, 'invalid_loadout', 'That loadout cannot be fielded.', { problems });
}

export async function registerSkills(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/skills',
    { preHandler: app.requireAccount, schema: { params: characterParamsSchema } },
    async (request): Promise<SkillsResponse> => {
      const accountId = request.auth!.account.id;
      const [hero] = await app.db
        .select()
        .from(characters)
        .where(
          and(
            eq(characters.id, request.params.characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        );
      if (!hero) throw characterNotFound();
      return skillsView(app.db, hero);
    },
  );

  // Save a preset's loadout (any preset; the one in force takes effect after the settlement).
  app.put<{
    Params: { characterId: string; preset: number };
    Body: { actives: (string | null)[]; passive: string | null };
  }>(
    '/characters/:characterId/skills/presets/:preset',
    {
      preHandler: app.requireAccount,
      schema: { params: presetParamsSchema, body: loadoutBodySchema },
    },
    async (request): Promise<SkillsResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId, preset } = request.params;
      return withTransaction(app.db, async (tx) => {
        // Locks the hero and settles its activity with the loadout in force until now.
        const hero = await lockOwnedCharacter(tx, accountId, characterId, activity);
        const loadout = canonicalLoadout(hero.classId, request.body as Loadout);
        // Validated against the hero as it is after the settlement (its level and deeds).
        const problems = validateLoadout(hero.classId, loadout, heroFacts(hero));
        if (problems.length > 0) throw invalidLoadout(problems);
        const before = (await loadPresets(tx, hero.id)).find((p) => p.preset === preset)!;
        const previous = canonicalLoadout(hero.classId, before.loadout);
        if (!sameLoadout(previous, loadout)) {
          const now = activity.now();
          if (isDefaultLoadout(hero.classId, loadout)) {
            // No row is the default loadout: a hero back on it is stored exactly as before 9.2.
            await tx
              .delete(characterLoadouts)
              .where(
                and(
                  eq(characterLoadouts.characterId, hero.id),
                  eq(characterLoadouts.preset, preset),
                ),
              );
          } else {
            await tx
              .insert(characterLoadouts)
              .values({
                characterId: hero.id,
                preset,
                actives: [...loadout.actives],
                passive: loadout.passive ?? null,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [characterLoadouts.characterId, characterLoadouts.preset],
                set: {
                  actives: [...loadout.actives],
                  passive: loadout.passive ?? null,
                  updatedAt: now,
                },
              });
          }
          await writeAudit(tx, {
            event: 'skills.loadout_save',
            accountId,
            characterId: hero.id,
            data: {
              preset,
              inForce: preset === hero.loadoutPreset,
              before: previous,
              after: loadout,
            },
          });
          recordTelemetry(tx, now, [
            {
              metric: 'skills.loadout',
              dims: [hero.classId, loadoutTelemetryKey(hero.classId, loadout), 'save'],
            },
          ]);
        }
        return skillsView(tx, hero);
      });
    },
  );

  // Switch the preset in force.
  app.post<{ Params: { characterId: string }; Body: { preset: number } }>(
    '/characters/:characterId/skills/preset',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, body: switchBodySchema },
    },
    async (request): Promise<SkillsResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { preset } = request.body;
      return withTransaction(app.db, async (tx) => {
        let hero = await lockOwnedCharacter(tx, accountId, characterId, activity);
        if (hero.loadoutPreset !== preset) {
          const now = activity.now();
          const from = hero.loadoutPreset;
          const [written] = await tx
            .update(characters)
            .set({ loadoutPreset: preset, updatedAt: now })
            .where(eq(characters.id, hero.id))
            .returning();
          hero = written!;
          const stored = (await loadPresets(tx, hero.id)).find((p) => p.preset === preset)!;
          const loadout = effectiveLoadout(
            hero.classId,
            stored.loadout ?? defaultLoadout(hero.classId),
            heroFacts(hero),
          );
          await writeAudit(tx, {
            event: 'skills.loadout_switch',
            accountId,
            characterId: hero.id,
            data: { from, to: preset, loadout: canonicalLoadout(hero.classId, loadout) },
          });
          recordTelemetry(tx, now, [
            {
              metric: 'skills.loadout',
              dims: [hero.classId, loadoutTelemetryKey(hero.classId, loadout), 'switch'],
            },
          ]);
        }
        return skillsView(tx, hero);
      });
    },
  );
}
