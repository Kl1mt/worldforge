import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  ITEM_BASES,
  canClassUseItem,
  createRng,
  equipmentSlotsForKind,
  generateItem,
  type ClassId,
  type RarityId,
} from '@worldforge/game-core';
import { SESSION_COOKIE } from '../auth/index.js';
import { blocks, duelOffers, friendships, itemInstances, sanctions } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import type { TestAccount } from './social.js';

/** Test support for the arena (ticket 5.5). */

/**
 * Equips a hero with one generated item per slot of the best regular base the class can use at
 * `itemLevel` (valid by `validateItem`), replacing what it wore. Deterministic per `tag`.
 */
export async function equipKit(
  db: Database,
  characterId: string,
  classId: ClassId,
  itemLevel: number,
  rarityId: RarityId = 'rare',
  tag = 'kit',
) {
  await db.delete(itemInstances).where(eq(itemInstances.characterId, characterId));
  const rng = createRng(`arena-test:${tag}:${classId}:${itemLevel}:${rarityId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of equipmentSlotsForKind(base.slot)) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel,
        baseId: base.id,
        rarityId,
        classId,
      })!;
      await db.insert(itemInstances).values({
        id: uuidv7(),
        characterId,
        seed: item.seed,
        baseId: item.baseId,
        rarityId: item.rarityId,
        itemLevel: item.itemLevel,
        affixes: item.affixes,
        effectId: item.effectId ?? null,
        effectRoll: item.effectRoll ?? null,
        setId: item.setId ?? null,
        mythicId: item.mythicId ?? null,
        variant: item.variant ?? null,
        equippedSlot: slot,
        source: 'test',
      });
    }
  }
}

export async function befriend(db: Database, a: string, b: string, status: 'pending' | 'friends') {
  const [low, high] = a < b ? [a, b] : [b, a];
  await db.insert(friendships).values({
    accountLow: low,
    accountHigh: high,
    status,
    requestedBy: a,
    acceptedAt: status === 'friends' ? new Date() : null,
  });
}

export async function block(db: Database, blocker: string, blocked: string) {
  await db.insert(blocks).values({ blockerId: blocker, blockedId: blocked });
}

export async function sanction(
  db: Database,
  subjectId: string,
  kind: 'mute' | 'suspend',
  expiresAt: Date,
  // Issued on the test's clock, not the database's wall clock: the expiry check needs it before
  // `expiresAt`, and a fixed test date falls behind the wall clock (`sanctions_expiry_check`).
  createdAt: Date = new Date(expiresAt.getTime() - 86_400_000),
) {
  await db.insert(sanctions).values({
    id: uuidv7(),
    subjectId,
    kind,
    reason: 'Test sanction.',
    createdAt,
    expiresAt,
  });
}

/** Sets a hero's offered list directly (test set-up: explicit instead of a random draw). */
export async function setOffer(
  db: Database,
  accountId: string,
  characterId: string,
  bracketId: string,
  defenceIds: string[],
  offeredAt: Date,
) {
  await db
    .insert(duelOffers)
    .values({ characterId, accountId, bracketId, defenceIds, offeredAt })
    .onConflictDoUpdate({
      target: duelOffers.characterId,
      set: { bracketId, defenceIds, offeredAt },
    });
}

/** The arena routes as one account calls them. */
export function arenaCalls(app: FastifyInstance) {
  const inject = (
    who: TestAccount,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
      cookies: { [SESSION_COOKIE]: who.token },
    });
  return {
    inject,
    state: (who: TestAccount, characterId: string) =>
      inject(who, 'GET', `/api/arena?characterId=${characterId}`),
    setDefence: (who: TestAccount, characterId: string) =>
      inject(who, 'POST', '/api/arena/defence', { characterId }),
    draw: (who: TestAccount, characterId: string) =>
      inject(who, 'POST', '/api/arena/opponents', { characterId }),
    duel: (
      who: TestAccount,
      characterId: string,
      defenceId: string,
      kind: 'rated' | 'friendly',
      key: string = randomUUID(),
    ) =>
      inject(
        who,
        'POST',
        '/api/arena/duels',
        { characterId, defenceId, kind },
        { 'idempotency-key': key },
      ),
    history: (who: TestAccount, query = '') => inject(who, 'GET', `/api/arena/duels${query}`),
    view: (who: TestAccount, duelId: string) => inject(who, 'GET', `/api/arena/duels/${duelId}`),
    friendly: (who: TestAccount) => inject(who, 'GET', '/api/arena/friendly'),
  };
}
