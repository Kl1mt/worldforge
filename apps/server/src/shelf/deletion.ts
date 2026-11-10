import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { characters, itemInstances } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { lockShelf } from './routes.js';

/**
 * Ticket T.7: the rule for hero deletion and the account shelf (docs/TRADING.md "T.7 exploit
 * review"). Hero deletion doesn't exist yet; this is the seam it must call, in its transaction,
 * before deleting the hero row (with T.5's `voidForDeletion`).
 *
 * Shelf items belong to the **account**: an item on the shelf keeps the `character_id` of the hero
 * who put it there, and that column cascades on delete. So before a hero goes, every shelf item it
 * placed is handed to another hero of the account (the oldest), still on the shelf, unchanged
 * otherwise (binding, lock, forge state, id), with one `shelf.rehome` audit row. Without another
 * hero the deletion is refused (`409 shelf_not_empty`): nothing on the shelf is ever lost with a
 * hero. Shelf gold and materials sit on the account row and are untouched.
 *
 * Locks: the account's shelf lock first (as every shelf move), then the hero rows, then the items.
 * Returns how many items changed hands. `server/src/shelf/shelf.test.ts` guards that no code
 * deletes a hero without calling this.
 */
export async function rehomeShelfItemsForDeletion(
  tx: Transaction,
  accountId: string,
  characterId: string,
  now: Date,
): Promise<number> {
  await lockShelf(tx, accountId);
  const placed = await tx
    .select({ id: itemInstances.id })
    .from(itemInstances)
    .where(
      and(
        eq(itemInstances.characterId, characterId),
        eq(itemInstances.onShelf, true),
        eq(itemInstances.shelfAccountId, accountId),
      ),
    )
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id))
    .for('update');
  if (placed.length === 0) return 0;
  const [heir] = await tx
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.accountId, accountId),
        ne(characters.id, characterId),
        // Ticket D.4: never a soft-deleted hero.
        isNull(characters.deletedAt),
      ),
    )
    .orderBy(asc(characters.createdAt), asc(characters.id))
    .limit(1)
    .for('update');
  if (!heir) {
    throw new ApiError(
      409,
      'shelf_not_empty',
      'Take this hero’s items off the shared shelf first: they would have no hero to belong to.',
      { items: placed.length },
    );
  }
  const moved = await tx
    .update(itemInstances)
    .set({ characterId: heir.id })
    .where(
      and(
        eq(itemInstances.characterId, characterId),
        eq(itemInstances.onShelf, true),
        eq(itemInstances.shelfAccountId, accountId),
      ),
    )
    .returning({ id: itemInstances.id });
  await writeAudit(tx, {
    event: 'shelf.rehome',
    accountId,
    characterId: heir.id,
    data: {
      fromCharacterId: characterId,
      toCharacterId: heir.id,
      itemIds: moved.map((m) => m.id),
      at: now.toISOString(),
    },
  });
  return moved.length;
}
