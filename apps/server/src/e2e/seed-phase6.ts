import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ClassId, ItemVariantId, WorldProgress } from '@worldforge/game-core';
import { generateAdminItem } from '../admin/tool-routes.js';
import { SESSION_COOKIE, createSession, hashPassword, revokeSession } from '../auth/index.js';
import { completeProject } from '../community/project-cli.js';
import { grantCosmeticsTx } from '../cosmetics/grant.js';
import { accounts, characters, itemInstances } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { changeGold } from '../economy/shared.js';
import { scheduleEvent } from '../events/model.js';
import { itemBindingColumns, itemEffectColumns } from '../inventory/columns.js';
import { setAccountRole } from '../social/roles.js';
import { equipKit } from '../test/arena.js';
import { giveMaterials } from '../test/trading.js';

/**
 * Test-only seed for the Phase 6 browser run (ticket 6.10, `tools/e2e/phase6-exit.mjs`), started by
 * `E2E_SEED_PHASE6=1` on the e2e server (`serve.ts`, which refuses `NODE_ENV=production`). It sets
 * up, directly through the database and the server's own model functions and test fixtures, what
 * the owner, the town and many hours of play would otherwise provide; the flows themselves (the
 * map, the Tyrant's door and a run, the Heroic door, an awakening, equipping a keepsake, the
 * admin's Events tab and animation gallery) run through the real UI and API:
 * - the town's works done (the owner's `admin:project complete` for the Warehouse, the Ashen Pass
 *   and the Forgeward Outpost): the town is in the Forgeward Age;
 * - a Harvest of Bones scheduled from now for 7 days (`scheduleEvent`, `via: 'cli'`, on the game
 *   clock), so it is under way when the run starts;
 * - three accounts (password `ashes-and-iron-42`, `@graumark.test`, email verified, guide
 *   dismissed), each with a hero made through the character route, then set up in the database:
 *   - **Hralda Vey** (`p6-hralda@`, Warrior "Hralda", level 38, the Gravewarden, crypt tier III and
 *     the Ashen Warden behind her): the Cinder Depths' top Legendaries +10 worn (item level 39,
 *     each one ready to awaken), the price of one awakening (gold, three Tyrant's Embers, two
 *     Gravewarden Seals, soul shards), a Prismatic ring and a Void hauberk in the pack (game-core's
 *     generator through the admin grant's own `generateAdminItem`), and two keepsakes granted
 *     through `grantCosmeticsTx` (the Forgeward and Warden-flame banners);
 *   - **Tamsin Coldlamp** (`p6-tamsin@`, Hunter "Tamsin", level 34, the same progress): the Depths
 *     open to her, the Tyrant's Forge (level 36) still barred: the door's level gate;
 *   - **Ysolde Marr** (`p6-ysolde@`, Warrior "Ysolde", level 1), made an admin with the role
 *     function `pnpm admin:role` uses, for the Events tab and the animation gallery.
 * The setup sessions are revoked at the end. Nothing is seeded when Hralda already exists (a kept
 * `E2E_DATA_DIR` database).
 */

export const PHASE6_PASSWORD = 'ashes-and-iron-42';

interface SeedHero {
  email: string;
  displayName: string;
  hero: string;
  classId: ClassId;
  level: number;
}

export const PHASE6_PLAYERS = {
  hralda: {
    email: 'p6-hralda@graumark.test',
    displayName: 'Hralda Vey',
    hero: 'Hralda',
    classId: 'warrior',
    level: 38,
  },
  tamsin: {
    email: 'p6-tamsin@graumark.test',
    displayName: 'Tamsin Coldlamp',
    hero: 'Tamsin',
    classId: 'hunter',
    level: 34,
  },
  ysolde: {
    email: 'p6-ysolde@graumark.test',
    displayName: 'Ysolde Marr',
    hero: 'Ysolde',
    classId: 'warrior',
    level: 1,
  },
} satisfies Record<string, SeedHero>;

/** The two keepsakes Hralda owns (the book's "Earned"); every other one stays locked. */
export const PHASE6_COSMETICS = ['banner.forgeward', 'banner.warden-flame'] as const;

/** Her variant pieces in the pack: game-core's generator at a fixed seed (validated). */
export const PHASE6_VARIANT_ITEMS: readonly {
  baseId: string;
  variant: ItemVariantId;
  seed: number;
}[] = [
  { baseId: 'iron-ring', variant: 'prismatic', seed: 6_100 },
  { baseId: 'vigil-hauberk', variant: 'void', seed: 6_101 },
];

const DAY = 86_400_000;
const LATE_PROGRESS: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 3,
  ashenWardenDefeated: true,
};

export async function seedPhase6(app: FastifyInstance, db: Database, now: () => Date) {
  await app.ready();
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.email, PHASE6_PLAYERS.hralda.email));
  if (existing) return;

  // The town's works, in order (each opens the next): the Forgeward Age.
  for (const project of ['restoreWarehouse', 'clearAshenPass', 'forgewardOutpost']) {
    await completeProject(db, project, now());
  }
  app.worldState.invalidate();
  const start = now();
  await scheduleEvent(
    db,
    {
      definitionId: 'harvestOfBones',
      startsAt: start,
      endsAt: new Date(start.getTime() + 7 * DAY),
    },
    start,
    { accountId: null, via: 'cli' },
  );

  const passwordHash = await hashPassword(PHASE6_PASSWORD);
  const real = new Date();
  const made: Record<string, { id: string; characterId: string; sid: string }> = {};
  for (const [key, p] of Object.entries(PHASE6_PLAYERS) as [string, SeedHero][]) {
    const [account] = await db
      .insert(accounts)
      .values({
        id: uuidv7(),
        email: p.email,
        displayName: p.displayName,
        passwordHash,
        createdAt: new Date(real.getTime() - 30 * DAY),
        updatedAt: real,
        emailVerifiedAt: real,
        guide: { steps: [], dismissed: true },
      })
      .returning();
    const session = await createSession(db, account!.id, real, DAY);
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { name: p.hero, classId: p.classId, appearance: { banner: 'ember' } },
      cookies: { [SESSION_COOKIE]: session.token },
    });
    if (res.statusCode !== 201) throw new Error(`seeding ${p.hero} failed: ${res.body}`);
    const characterId = res.json<{ character: { id: string } }>().character.id;
    if (p.level > 1) {
      await db
        .update(characters)
        .set({ level: p.level, experience: 0, progress: LATE_PROGRESS })
        .where(eq(characters.id, characterId));
    }
    made[key] = { id: account!.id, characterId, sid: session.sessionId };
  }
  const { hralda, tamsin, ysolde } = made as Record<
    keyof typeof PHASE6_PLAYERS,
    (typeof made)[string]
  >;

  // Hralda: the Depths' top Legendaries +10, worn (as the Phase 6 journey tests seed them).
  await equipKit(db, hralda!.characterId, 'warrior', 39, 'legendary', 'phase6');
  await db
    .update(itemInstances)
    .set({ upgradeLevel: 10 })
    .where(
      and(
        eq(itemInstances.characterId, hralda!.characterId),
        isNotNull(itemInstances.equippedSlot),
      ),
    );
  await equipKit(db, tamsin!.characterId, 'hunter', 35, 'epic', 'phase6');
  // The price of one awakening at item level 39 (and change), through the one gold writer.
  await withTransaction(db, async (tx) => {
    const [hero] = await tx.select().from(characters).where(eq(characters.id, hralda!.characterId));
    await changeGold(tx, hero!, 60_000, real);
  });
  await giveMaterials(db, hralda!.characterId, {
    tyrantsEmber: 3,
    gravewardenSeal: 2,
    soulShard: 30,
  });
  for (const spec of PHASE6_VARIANT_ITEMS) {
    const item = generateAdminItem(
      { ...spec, rarityId: 'legendary', itemLevel: 37, upgradeLevel: 0 },
      'warrior',
    );
    await db.insert(itemInstances).values({
      id: uuidv7(),
      characterId: hralda!.characterId,
      baseId: item.baseId,
      rarityId: item.rarityId,
      itemLevel: item.itemLevel,
      affixes: item.affixes,
      seed: item.seed,
      ...itemEffectColumns(item),
      upgradeLevel: item.upgradeLevel,
      ...itemBindingColumns(item, 'test', hralda!.id),
      source: 'test',
      createdAt: now(),
    });
  }
  await withTransaction(db, (tx) =>
    grantCosmeticsTx(
      tx,
      { accountId: hralda!.id, now: now(), source: 'e2e:phase6', characterId: hralda!.characterId },
      PHASE6_COSMETICS,
    ),
  );

  await setAccountRole(db, PHASE6_PLAYERS.ysolde.email, 'admin');
  for (const who of [hralda!, tamsin!, ysolde!]) await revokeSession(db, who.sid, new Date());
}
