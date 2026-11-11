import { inArray } from 'drizzle-orm';
import { heroAppearances } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/**
 * Ticket 6.8: the appearance (palette id) each hero shows; heroes without a row wear their class's
 * own colours and are left out. The caller decides who may see it (docs/COSMETICS.md "Privacy":
 * shown where the hero's name is shown). The account's banner, crest and title colour travel with
 * its prestige display (`prestigeFor`).
 */
export async function heroPalettes(
  executor: Executor,
  characterIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(characterIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ id: heroAppearances.characterId, appearance: heroAppearances.appearance })
    .from(heroAppearances)
    .where(inArray(heroAppearances.characterId, ids));
  return new Map(rows.map((r) => [r.id, r.appearance]));
}
