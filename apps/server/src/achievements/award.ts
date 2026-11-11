import { and, count, eq, inArray, isNotNull, max } from 'drizzle-orm';
import {
  RARITY_IDS,
  achievementsEarned,
  cryptTierCleared,
  isRarityId,
  wornSets,
  type AchievementFacts,
  type RarityId,
  type WorldProgress,
} from '@worldforge/game-core';
import {
  accountAchievements,
  characterQuests,
  characters,
  communityContributions,
  communityProjects,
  itemInstances,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { grantForAchievementsTx, grantMilestonesTx } from '../cosmetics/grant.js';
import type { Executor } from '../db/types.js';

/**
 * Server-side achievement awarding (ticket 4.2, docs/SOCIAL.md "Achievements").
 *
 * The events that already exist (settlement, crypt claim, quest turn-in, forge, merchant, equip)
 * call `refreshAchievements` inside their own transaction, after their change, naming the facts
 * the event can have changed. The facts are read from the character's state as it is inside that
 * transaction, game-core decides what they earn, and new awards are inserted with
 * `on conflict do nothing` on the (account, achievement) primary key: at most one award per
 * account and achievement whatever runs concurrently (two characters, the backfill), and only
 * the insert that created the row writes its `achievement.award` audit row.
 */
export type FactKey = keyof AchievementFacts;

export const ALL_FACTS: readonly FactKey[] = [
  'maxRarity',
  'maxUpgradeLevel',
  'maxCharacterLevel',
  'gravewardenDefeated',
  'cryptTierCleared',
  'fullSetWorn',
  'contractsTurnedIn',
  'storyQuestsTurnedIn',
  'communityProjects',
];

/** The character fields the facts read (pass the row as it is after the event's change). */
export interface FactCharacter {
  id: string;
  accountId: string;
  level: number;
  progress: WorldProgress;
}

export function rarest(rarities: Iterable<string>): RarityId | null {
  let best = -1;
  for (const r of rarities) if (isRarityId(r)) best = Math.max(best, RARITY_IDS.indexOf(r));
  return best < 0 ? null : RARITY_IDS[best]!;
}

/** The facts `keys` of one character (and its account, for account-wide counts). */
export async function characterFacts(
  executor: Executor,
  character: FactCharacter,
  keys: readonly FactKey[],
): Promise<AchievementFacts> {
  const want = new Set(keys);
  const facts: AchievementFacts = {};
  if (want.has('maxCharacterLevel')) facts.maxCharacterLevel = character.level;
  if (want.has('gravewardenDefeated')) {
    facts.gravewardenDefeated = character.progress.gravewardenDefeated === true;
  }
  if (want.has('cryptTierCleared')) facts.cryptTierCleared = cryptTierCleared(character.progress);
  if (want.has('maxRarity')) {
    const rows = await executor
      .selectDistinct({ rarityId: itemInstances.rarityId })
      .from(itemInstances)
      .where(eq(itemInstances.characterId, character.id));
    facts.maxRarity = rarest(rows.map((r) => r.rarityId));
  }
  if (want.has('maxUpgradeLevel')) {
    const [row] = await executor
      .select({ level: max(itemInstances.upgradeLevel) })
      .from(itemInstances)
      .where(eq(itemInstances.characterId, character.id));
    facts.maxUpgradeLevel = row?.level ?? 0;
  }
  if (want.has('fullSetWorn')) {
    const worn = await executor
      .select({ baseId: itemInstances.baseId, setId: itemInstances.setId })
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, character.id),
          isNotNull(itemInstances.equippedSlot),
          isNotNull(itemInstances.setId),
        ),
      );
    facts.fullSetWorn = wornSets(worn).some((w) => w.pieces.length === w.set.pieces.length);
  }
  if (want.has('contractsTurnedIn')) {
    const [row] = await executor
      .select({ n: count() })
      .from(characterQuests)
      .innerJoin(characters, eq(characters.id, characterQuests.characterId))
      .where(
        and(
          eq(characters.accountId, character.accountId),
          eq(characterQuests.kind, 'contract'),
          eq(characterQuests.status, 'turnedIn'),
        ),
      );
    facts.contractsTurnedIn = row?.n ?? 0;
  }
  if (want.has('storyQuestsTurnedIn')) {
    const rows = await executor
      .select({ questId: characterQuests.questId })
      .from(characterQuests)
      .where(
        and(
          eq(characterQuests.characterId, character.id),
          eq(characterQuests.kind, 'story'),
          eq(characterQuests.status, 'turnedIn'),
        ),
      );
    facts.storyQuestsTurnedIn = rows.map((r) => r.questId);
  }
  if (want.has('communityProjects')) {
    // Ticket 4.6: completed projects the account gave to (account-wide, like contracts).
    const rows = await executor
      .selectDistinct({ projectId: communityContributions.projectId })
      .from(communityContributions)
      .innerJoin(
        communityProjects,
        eq(communityProjects.projectId, communityContributions.projectId),
      )
      .where(
        and(
          eq(communityContributions.accountId, character.accountId),
          isNotNull(communityProjects.completedAt),
        ),
      );
    facts.communityProjects = rows.map((r) => r.projectId);
  }
  return facts;
}

export interface AwardContext {
  accountId: string;
  /** The hero that earned it; null when the backfill cannot tie it to one. */
  characterId: string | null;
  now: Date;
  source: 'live' | 'backfill';
}

/**
 * Awards what `facts` earn and the account does not have yet. Returns the ids this call awarded
 * (an award a concurrent transaction made first is not returned and not audited again).
 */
export async function awardAchievements(
  executor: Executor,
  ctx: AwardContext,
  facts: AchievementFacts,
): Promise<string[]> {
  const earned = achievementsEarned(facts);
  if (earned.length === 0) return [];
  const have = await executor
    .select({ id: accountAchievements.achievementId })
    .from(accountAchievements)
    .where(
      and(
        eq(accountAchievements.accountId, ctx.accountId),
        inArray(accountAchievements.achievementId, earned),
      ),
    );
  const owned = new Set(have.map((h) => h.id));
  const missing = earned.filter((id) => !owned.has(id));
  if (missing.length === 0) return [];
  const inserted = await executor
    .insert(accountAchievements)
    .values(
      missing.map((achievementId) => ({
        accountId: ctx.accountId,
        achievementId,
        characterId: ctx.characterId,
        source: ctx.source,
        awardedAt: ctx.now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: accountAchievements.achievementId });
  const awarded = missing.filter((id) => inserted.some((r) => r.id === id));
  for (const achievementId of awarded) {
    await writeAudit(executor, {
      event: 'achievement.award',
      accountId: ctx.accountId,
      characterId: ctx.characterId,
      data: { achievementId, source: ctx.source },
    });
  }
  // Ticket 6.8: the cosmetics that come with these achievements, in the same transaction.
  await grantForAchievementsTx(
    executor,
    {
      accountId: ctx.accountId,
      characterId: ctx.characterId,
      now: ctx.now,
      backfill: ctx.source === 'backfill',
    },
    awarded,
  );
  return awarded;
}

/**
 * The hook the existing events call, inside their transaction and after their change: collects
 * the facts `keys` of `character` (its state after the change) and awards what they earn.
 */
export async function refreshAchievements(
  executor: Executor,
  character: FactCharacter,
  keys: readonly FactKey[],
  now: Date,
): Promise<string[]> {
  const facts = await characterFacts(executor, character, keys);
  const awarded = await awardAchievements(
    executor,
    { accountId: character.accountId, characterId: character.id, now, source: 'live' },
    facts,
  );
  // Ticket 6.8: milestone cosmetics (level 40, a boss slain, the Heroic crypt) from the hero's row.
  await grantMilestonesTx(executor, character, now);
  return awarded;
}
