import { and, eq, inArray } from 'drizzle-orm';
import {
  cosmeticsForAchievements,
  findCosmetic,
  milestoneCosmeticsEarned,
  seasonCosmeticsEarned,
  type MilestoneHero,
  type PrestigeTier,
} from '@worldforge/game-core';
import { cosmeticUnlocks } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor } from '../db/types.js';

/**
 * Cosmetic grants (ticket 6.8, docs/COSMETICS.md "Granting"). Every grant inserts into
 * `cosmetic_unlocks` with `on conflict do nothing` on its `(account, cosmetic)` primary key, so a
 * cosmetic is granted **exactly once** per account whatever runs at the same time (two heroes, a
 * live grant and the backfill, two backfills), and only the insert that created the row writes the
 * `cosmetic.grant` audit row. The callers are the transactions of the source events:
 * - achievements: `awardAchievements` (every live award and the achievement backfill);
 * - milestones: `refreshAchievements` (settlements that change the level, dungeon claims);
 * - season honours: `awardSeason`'s last transaction;
 * - events: 6.6's `grantTiersTx` (its own ledger; audited as `event.reward`).
 * Grants never touch a gameplay row.
 */

export interface GrantContext {
  accountId: string;
  now: Date;
  /** `achievement:<id>`, `milestone:<character id>`, `season:<n>` (`backfill:` prefixed). */
  source: string;
  characterId?: string | null;
}

/** Grants `ids` the account does not own yet; returns the ids this call granted. */
export async function grantCosmeticsTx(
  executor: Executor,
  ctx: GrantContext,
  ids: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => {
    const c = findCosmetic(id);
    return c !== undefined && c.source.kind !== 'default';
  });
  if (wanted.length === 0) return [];
  const have = await executor
    .select({ id: cosmeticUnlocks.cosmeticId })
    .from(cosmeticUnlocks)
    .where(
      and(
        eq(cosmeticUnlocks.accountId, ctx.accountId),
        inArray(cosmeticUnlocks.cosmeticId, wanted),
      ),
    );
  const owned = new Set(have.map((h) => h.id));
  const missing = wanted.filter((id) => !owned.has(id));
  if (missing.length === 0) return [];
  const inserted = await executor
    .insert(cosmeticUnlocks)
    .values(
      missing.map((cosmeticId) => ({
        accountId: ctx.accountId,
        cosmeticId,
        source: ctx.source,
        grantedAt: ctx.now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: cosmeticUnlocks.cosmeticId });
  const granted = missing.filter((id) => inserted.some((r) => r.id === id));
  for (const cosmeticId of granted) {
    await writeAudit(executor, {
      event: 'cosmetic.grant',
      accountId: ctx.accountId,
      characterId: ctx.characterId ?? null,
      data: { cosmeticId, kind: findCosmetic(cosmeticId)!.kind, source: ctx.source },
    });
  }
  return granted;
}

/** The cosmetics that come with these achievements (called with every new award). */
export async function grantForAchievementsTx(
  executor: Executor,
  ctx: { accountId: string; characterId: string | null; now: Date; backfill?: boolean },
  achievementIds: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const achievementId of achievementIds) {
    const ids = cosmeticsForAchievements([achievementId]);
    if (ids.length === 0) continue;
    out.push(
      ...(await grantCosmeticsTx(
        executor,
        {
          accountId: ctx.accountId,
          characterId: ctx.characterId,
          now: ctx.now,
          source: `${ctx.backfill ? 'backfill:' : ''}achievement:${achievementId}`,
        },
        ids,
      )),
    );
  }
  return out;
}

/** The milestone cosmetics a hero has reached (its row after the change). */
export async function grantMilestonesTx(
  executor: Executor,
  hero: MilestoneHero & { id: string; accountId: string },
  now: Date,
  { backfill = false } = {},
): Promise<string[]> {
  const ids = milestoneCosmeticsEarned(hero);
  if (ids.length === 0) return [];
  return grantCosmeticsTx(
    executor,
    {
      accountId: hero.accountId,
      characterId: hero.id,
      now,
      source: `${backfill ? 'backfill:' : ''}milestone:${hero.id}`,
    },
    ids,
  );
}

/** The season cosmetics an account's honours of one season earn. */
export async function grantSeasonTx(
  executor: Executor,
  accountId: string,
  season: number,
  tiers: readonly PrestigeTier[],
  now: Date,
  { backfill = false } = {},
): Promise<string[]> {
  const ids = seasonCosmeticsEarned(tiers);
  if (ids.length === 0) return [];
  return grantCosmeticsTx(
    executor,
    { accountId, now, source: `${backfill ? 'backfill:' : ''}season:${season}` },
    ids,
  );
}
