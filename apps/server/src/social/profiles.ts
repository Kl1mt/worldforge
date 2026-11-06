import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  ACHIEVEMENT_IDS,
  EQUIPMENT_SLOT_IDS,
  HANDLE_RE,
  MAX_SHOWN_ACHIEVEMENTS,
  PROFILE_VISIBILITIES,
  canViewProfile,
  type CharacterAppearance,
  type ClassId,
  type EquipmentSlotId,
  type ProfileRelation,
  type ProfileVisibility,
  type Relation,
} from '@worldforge/game-core';
import {
  accountAchievements,
  accounts,
  characters,
  itemInstances,
  type Account,
  type ItemInstance,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor } from '../db/types.js';
import { ApiError } from '../errors.js';
import { normalizeDisplayName } from '../auth/validation.js';
import { relationBetween } from './relations.js';
import { hiddenTargetKeys } from './sanctions.js';
import { socialWrite } from './social-write.js';
import { characterNameKey, profileFieldKey } from './targets.js';

/**
 * Public profiles (ticket 4.2, docs/SOCIAL.md "Profiles"): the lookup by display name or handle,
 * the profile view, and the owner's settings. A profile the viewer may not see answers exactly
 * like an unknown player (`404 not_found`), so hidden profiles and blocks cannot be probed.
 */

/**
 * The viewer's relation to the owner, from 4.3's relationship model (`relationBetween`): a block
 * in either direction is `blocked` (404, like an unknown player), a friendship is `friend`, a
 * pending request either way is `pending` (not a friend). Guilds arrive in 4.4.
 * TODO(4.4): a shared guild → `guildmate`.
 */
export async function profileRelation(
  executor: Executor,
  viewerId: string,
  ownerId: string,
): Promise<ProfileRelation> {
  return PROFILE_RELATION_OF[await relationBetween(executor, viewerId, ownerId)];
}

const PROFILE_RELATION_OF: Record<Relation, ProfileRelation> = {
  self: 'self',
  stranger: 'stranger',
  'requested-by-me': 'pending',
  'requested-by-them': 'pending',
  friend: 'friend',
  'blocked-by-me': 'blocked',
  'blocked-by-them': 'blocked',
};

/** The owner if `viewerId` may see their profile, else null (the caller answers 404). */
export async function viewableProfileOwner(
  executor: Executor,
  viewerId: string,
  owner: Account | undefined,
): Promise<Account | null> {
  if (!owner) return null;
  const relation = await profileRelation(executor, viewerId, owner.id);
  return canViewProfile(owner.profileVisibility, relation) ? owner : null;
}

const notFound = () => new ApiError(404, 'not_found', 'No player by that name.');

async function ownerBy(
  executor: Executor,
  by: { handle: string } | { name: string },
): Promise<Account | undefined> {
  if ('handle' in by) {
    if (!HANDLE_RE.test(by.handle)) return undefined;
    const [row] = await executor.select().from(accounts).where(eq(accounts.handle, by.handle));
    return row;
  }
  const name = normalizeDisplayName(by.name);
  const [row] = await executor
    .select()
    .from(accounts)
    .where(sql`lower(${accounts.displayName}) = lower(${name})`)
    .limit(1);
  return row;
}

/** An equipped item as other players see it: no ids, seeds, sources or dates. */
export interface ShowcaseItemView {
  slot: EquipmentSlotId;
  baseId: string;
  rarityId: string;
  itemLevel: number;
  affixes: ItemInstance['affixes'];
  upgradeLevel: number;
  variant: string | null;
  effectId: string | null;
  effectRoll: number | null;
  setId: string | null;
  mythicId: string | null;
}

export interface ProfileCharacterView {
  /** Null while a moderator hides the name. */
  name: string | null;
  classId: ClassId;
  level: number;
  appearance: CharacterAppearance;
}

export interface ProfileView {
  handle: string;
  /** Null while a moderator hides it (others only). */
  displayName: string | null;
  self: boolean;
  /** The owner's own setting; null for everyone else. */
  visibility: ProfileVisibility | null;
  characters: ProfileCharacterView[];
  /** The achievements the owner chose to show, in their order; `awardedOn` is the UTC day. */
  achievements: { id: string; awardedOn: string }[];
  showcase: (ProfileCharacterView & { equipped: ShowcaseItemView[] }) | null;
}

function showcaseItem(i: ItemInstance): ShowcaseItemView {
  return {
    slot: i.equippedSlot!,
    baseId: i.baseId,
    rarityId: i.rarityId,
    itemLevel: i.itemLevel,
    affixes: i.affixes,
    upgradeLevel: i.upgradeLevel,
    variant: i.variant ?? null,
    effectId: i.effectId ?? null,
    effectRoll: i.effectRoll ?? null,
    setId: i.setId ?? null,
    mythicId: i.mythicId ?? null,
  };
}

export async function profileView(
  executor: Executor,
  owner: Account,
  viewerId: string,
  now: Date,
): Promise<ProfileView> {
  const self = owner.id === viewerId;
  const heroes = await executor
    .select()
    .from(characters)
    .where(eq(characters.accountId, owner.id))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  const hidden = self
    ? new Set<string>()
    : await hiddenTargetKeys(
        executor,
        [profileFieldKey(owner.id, 'displayName'), ...heroes.map((h) => characterNameKey(h.id))],
        now,
      );
  const heroView = (h: (typeof heroes)[number]): ProfileCharacterView => ({
    name: hidden.has(characterNameKey(h.id)) ? null : h.name,
    classId: h.classId,
    level: h.level,
    appearance: h.appearance,
  });
  const shown = await executor
    .select({ id: accountAchievements.achievementId, awardedAt: accountAchievements.awardedAt })
    .from(accountAchievements)
    .where(
      and(
        eq(accountAchievements.accountId, owner.id),
        isNotNull(accountAchievements.shownSlot),
        inArray(accountAchievements.achievementId, [...ACHIEVEMENT_IDS]),
      ),
    )
    .orderBy(asc(accountAchievements.shownSlot));
  const showcased = heroes.find((h) => h.id === owner.showcaseCharacterId);
  let showcase: ProfileView['showcase'] = null;
  if (showcased) {
    const slot = (s: EquipmentSlotId) => EQUIPMENT_SLOT_IDS.indexOf(s);
    const equipped = await executor
      .select()
      .from(itemInstances)
      .where(
        and(eq(itemInstances.characterId, showcased.id), isNotNull(itemInstances.equippedSlot)),
      );
    showcase = {
      ...heroView(showcased),
      equipped: equipped
        .sort((a, b) => slot(a.equippedSlot!) - slot(b.equippedSlot!))
        .map(showcaseItem),
    };
  }
  return {
    handle: owner.handle,
    displayName: hidden.has(profileFieldKey(owner.id, 'displayName')) ? null : owner.displayName,
    self,
    visibility: self ? owner.profileVisibility : null,
    characters: heroes.map(heroView),
    achievements: shown.map((a) => ({
      id: a.id,
      awardedOn: a.awardedAt.toISOString().slice(0, 10),
    })),
    showcase,
  };
}

const playerRefSchema = {
  type: 'object',
  required: ['handle', 'displayName'],
  properties: { handle: { type: 'string' }, displayName: { type: 'string' } },
} as const;

const heroSchema = {
  type: 'object',
  required: ['name', 'classId', 'level', 'appearance'],
  properties: {
    name: { type: ['string', 'null'] },
    classId: { type: 'string' },
    level: { type: 'integer' },
    appearance: {
      type: 'object',
      required: ['banner'],
      properties: { banner: { type: 'string' } },
    },
  },
} as const;

const showcaseItemSchema = {
  type: 'object',
  required: [
    'slot',
    'baseId',
    'rarityId',
    'itemLevel',
    'affixes',
    'upgradeLevel',
    'variant',
    'effectId',
    'effectRoll',
    'setId',
    'mythicId',
  ],
  properties: {
    slot: { type: 'string' },
    baseId: { type: 'string' },
    rarityId: { type: 'string' },
    itemLevel: { type: 'integer' },
    affixes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['affixId', 'tier', 'value'],
        properties: {
          affixId: { type: 'string' },
          tier: { type: 'integer' },
          value: { type: 'number' },
          improvements: { type: 'integer' },
          rerolled: { type: 'boolean' },
        },
      },
    },
    upgradeLevel: { type: 'integer' },
    variant: { type: ['string', 'null'] },
    effectId: { type: ['string', 'null'] },
    effectRoll: { type: ['number', 'null'] },
    setId: { type: ['string', 'null'] },
    mythicId: { type: ['string', 'null'] },
  },
} as const;

const profileSchema = {
  type: 'object',
  required: [
    'handle',
    'displayName',
    'self',
    'visibility',
    'characters',
    'achievements',
    'showcase',
  ],
  properties: {
    handle: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    self: { type: 'boolean' },
    visibility: { type: ['string', 'null'] },
    characters: { type: 'array', items: heroSchema },
    achievements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'awardedOn'],
        properties: { id: { type: 'string' }, awardedOn: { type: 'string' } },
      },
    },
    showcase: {
      type: ['object', 'null'],
      required: [...heroSchema.required, 'equipped'],
      properties: {
        ...heroSchema.properties,
        equipped: { type: 'array', items: showcaseItemSchema },
      },
    },
  },
} as const;

const settingsSchema = {
  type: 'object',
  required: ['visibility', 'showcaseCharacterId', 'shown', 'earned', 'characters'],
  properties: {
    visibility: { type: 'string' },
    showcaseCharacterId: { type: ['string', 'null'] },
    shown: { type: 'array', items: { type: 'string' } },
    earned: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'awardedAt', 'characterName'],
        properties: {
          id: { type: 'string' },
          awardedAt: { type: 'string' },
          characterName: { type: ['string', 'null'] },
        },
      },
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' } },
      },
    },
  },
} as const;

/** The owner's profile settings and every achievement they earned (their own view). */
async function settingsView(executor: Executor, account: Account) {
  const [owner] = await executor.select().from(accounts).where(eq(accounts.id, account.id));
  const heroes = await executor
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(eq(characters.accountId, account.id))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  const earned = await executor
    .select()
    .from(accountAchievements)
    .where(eq(accountAchievements.accountId, account.id))
    .orderBy(asc(accountAchievements.awardedAt), asc(accountAchievements.achievementId));
  const known = earned.filter((a) => ACHIEVEMENT_IDS.includes(a.achievementId));
  return {
    visibility: owner!.profileVisibility,
    showcaseCharacterId: owner!.showcaseCharacterId ?? null,
    shown: known
      .filter((a) => a.shownSlot !== null)
      .sort((a, b) => a.shownSlot! - b.shownSlot!)
      .map((a) => a.achievementId),
    earned: known.map((a) => ({
      id: a.achievementId,
      awardedAt: a.awardedAt.toISOString(),
      characterName: heroes.find((h) => h.id === a.characterId)?.name ?? null,
    })),
    characters: heroes,
  };
}

export async function registerProfiles(app: FastifyInstance): Promise<void> {
  // Find a player by display name or handle (the report dialog and the profile search; grown
  // from 4.1's minimal lookup). Public data only. A hidden display name, a profile the viewer may
  // not see and an unknown player all answer the same 404.
  app.get(
    '/players/lookup',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            handle: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: { type: 'object', required: ['player'], properties: { player: playerRefSchema } },
        },
      },
    },
    async (request) => {
      const q = request.query as { name?: string; handle?: string };
      const by = q.handle !== undefined ? { handle: q.handle.trim().toLowerCase() } : q.name;
      if (by === undefined) {
        throw new ApiError(400, 'validation_failed', 'Give a name or a handle.', {
          fields: { name: 'Give a name or a handle.' },
        });
      }
      const viewer = request.auth!.account;
      const owner = await viewableProfileOwner(
        app.db,
        viewer.id,
        await ownerBy(app.db, typeof by === 'string' ? { name: by } : by),
      );
      if (!owner) throw notFound();
      if (owner.id !== viewer.id) {
        const key = profileFieldKey(owner.id, 'displayName');
        if ((await hiddenTargetKeys(app.db, [key], app.authNow())).size > 0) throw notFound();
      }
      return { player: { handle: owner.handle, displayName: owner.displayName } };
    },
  );

  app.get<{ Params: { handle: string } }>(
    '/players/:handle/profile',
    {
      preHandler: app.requireAccount,
      schema: {
        params: {
          type: 'object',
          required: ['handle'],
          properties: { handle: { type: 'string', maxLength: 64 } },
        },
        response: {
          200: { type: 'object', required: ['profile'], properties: { profile: profileSchema } },
        },
      },
    },
    async (request) => {
      const viewer = request.auth!.account;
      const handle = request.params.handle.toLowerCase();
      const owner = await viewableProfileOwner(
        app.db,
        viewer.id,
        await ownerBy(app.db, { handle }),
      );
      if (!owner) throw notFound();
      return { profile: await profileView(app.db, owner, viewer.id, app.authNow()) };
    },
  );

  app.get(
    '/account/profile',
    {
      preHandler: app.requireAccount,
      schema: { response: { 200: settingsSchema } },
    },
    async (request) => settingsView(app.db, request.auth!.account),
  );

  // The owner's settings: visibility, the achievements shown (earned ones, in order, at most
  // MAX_SHOWN_ACHIEVEMENTS) and the showcased character (their own, or null). A social write
  // (rate limited, audited), exempt from mutes: it carries no player text.
  app.post(
    '/account/profile',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['visibility', 'shown', 'showcaseCharacterId'],
          properties: {
            visibility: { type: 'string', enum: [...PROFILE_VISIBILITIES] },
            shown: {
              type: 'array',
              maxItems: MAX_SHOWN_ACHIEVEMENTS,
              uniqueItems: true,
              items: { type: 'string', maxLength: 64 },
            },
            showcaseCharacterId: { type: ['string', 'null'], maxLength: 64 },
          },
        },
        response: { 200: settingsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        visibility: ProfileVisibility;
        shown: string[];
        showcaseCharacterId: string | null;
      };
      return socialWrite(app, request, reply, 'profile', async (tx, { account, now }) => {
        if (body.showcaseCharacterId !== null) {
          const [hero] = await tx
            .select({ id: characters.id })
            .from(characters)
            .where(
              and(
                sql`${characters.id}::text = ${body.showcaseCharacterId}`,
                eq(characters.accountId, account.id),
              ),
            );
          if (!hero) {
            throw new ApiError(422, 'not_your_character', 'Showcase one of your own heroes.', {
              fields: { showcaseCharacterId: 'Showcase one of your own heroes.' },
            });
          }
        }
        const earned = body.shown.length
          ? await tx
              .select({ id: accountAchievements.achievementId })
              .from(accountAchievements)
              .where(
                and(
                  eq(accountAchievements.accountId, account.id),
                  inArray(accountAchievements.achievementId, body.shown),
                ),
              )
          : [];
        const missing = body.shown.filter(
          (id) => !ACHIEVEMENT_IDS.includes(id) || !earned.some((e) => e.id === id),
        );
        if (missing.length > 0) {
          throw new ApiError(422, 'achievement_not_earned', 'Show only achievements you earned.', {
            fields: { shown: 'Show only achievements you earned.' },
            achievements: missing,
          });
        }
        await tx
          .update(accounts)
          .set({
            profileVisibility: body.visibility,
            showcaseCharacterId: body.showcaseCharacterId,
            updatedAt: now,
          })
          .where(eq(accounts.id, account.id));
        // Clear every slot, then number the chosen ones (the slot index is per statement).
        await tx
          .update(accountAchievements)
          .set({ shownSlot: null })
          .where(
            and(
              eq(accountAchievements.accountId, account.id),
              isNotNull(accountAchievements.shownSlot),
            ),
          );
        for (const [slot, id] of body.shown.entries()) {
          await tx
            .update(accountAchievements)
            .set({ shownSlot: slot })
            .where(
              and(
                eq(accountAchievements.accountId, account.id),
                eq(accountAchievements.achievementId, id),
              ),
            );
        }
        await writeAudit(tx, {
          event: 'profile.update',
          accountId: account.id,
          data: {
            visibility: body.visibility,
            shown: body.shown,
            showcaseCharacterId: body.showcaseCharacterId,
          },
        });
        return settingsView(tx, account);
      });
    },
  );
}
