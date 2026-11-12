import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  ITEM_BASES,
  canClassUseItem,
  createRng,
  generateItem,
  type ClassId,
  type RarityId,
  type WorldProgress,
} from '@worldforge/game-core';
import { SESSION_COOKIE, createSession, hashPassword, revokeSession } from '../auth/index.js';
import { completeProject } from '../community/project-cli.js';
import { accounts, characters, itemInstances, seasons } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { changeGold } from '../economy/shared.js';
import { notifyDropsTx } from '../inbox/notify.js';
import { itemBindingColumns, itemEffectColumns } from '../inventory/columns.js';
import { snapshotDeps } from '../leaderboards/routes.js';
import { sweepLeaderboards } from '../leaderboards/snapshot.js';
import { setAccountRole } from '../social/roles.js';
import { equipKit } from '../test/arena.js';
import { insertGuild } from '../test/guilds.js';
import { giveMaterials } from '../test/trading.js';

/**
 * Test-only seed for the Phase 8 browser run (ticket 8.7, `tools/e2e/phase8-exit.mjs`), started by
 * `E2E_SEED_PHASE8=1` on the e2e server (`serve.ts`, which refuses `NODE_ENV=production`). It sets
 * up, through the database and the server's own model functions and test fixtures, what the owner,
 * the town and weeks of play would otherwise provide; the flows themselves run through the real UI:
 * - four accounts (password `ashes-and-iron-42`, `@graumark.test`, email verified, a month old,
 *   guide dismissed), each with a hero made through the character route, then set up:
 *   - **Odric Lanternhand** (`p8-odric@`, Warrior "Odric", level 50, the Forge Tyrant behind him):
 *     the Marches' top Legendaries +10 worn (item level 47), 20,000 gold; he leads the guild "The
 *     Lantern Wardens" (founded 10 days ago, so its members count on the Guild Roll);
 *   - **Brynja Coldwick** (`p8-brynja@`, Hunter "Brynja", level 46, the Tyrant behind her): the
 *     Deep open to her, the Hollow Throne (level 48) still barred; officer of the Wardens;
 *   - **Cass Wenhallow** (`p8-cass@`, Mage "Cass", level 22): a pack of 18 mixed items (commons to
 *     a Legendary, two locked) for search and sorting, and four Tavern notices of which three are
 *     ready (story and contracts, their objectives filled in: test set-up) for "Claim all"; a
 *     member of the Wardens;
 *   - **Mira Castellane** (`p8-mira@`, Warrior "Mira", level 1), made an admin with the role
 *     function `pnpm admin:role` uses, for the Events tab's calendar and the Readiness tab.
 * - then the town's works, in order, by the owner's `admin:project complete` (the Warehouse, the
 *   Ashen Pass, the Forgeward Outpost and the lanterns of the deep): the Lantern Vigil, the Hollow
 *   Deep and the Throne open, and every account has the stages' and eras' letters;
 * - Season 1 under way (started 10 days ago, 28 days long), the boards refreshed (the 5.2 sweep),
 *   so the Guild Roll lists the Wardens; a drop letter for Odric (the shape `notifyDropsTx` writes).
 * The calendar stays paused (as in production). The setup sessions are revoked at the end. Nothing
 * is seeded when Odric already exists (a kept `E2E_DATA_DIR` database).
 */

export const PHASE8_PASSWORD = 'ashes-and-iron-42';

interface SeedHero {
  email: string;
  displayName: string;
  hero: string;
  classId: ClassId;
  level: number;
}

export const PHASE8_PLAYERS = {
  odric: {
    email: 'p8-odric@graumark.test',
    displayName: 'Odric Lanternhand',
    hero: 'Odric',
    classId: 'warrior',
    level: 50,
  },
  brynja: {
    email: 'p8-brynja@graumark.test',
    displayName: 'Brynja Coldwick',
    hero: 'Brynja',
    classId: 'hunter',
    level: 46,
  },
  cass: {
    email: 'p8-cass@graumark.test',
    displayName: 'Cass Wenhallow',
    hero: 'Cass',
    classId: 'mage',
    level: 22,
  },
  mira: {
    email: 'p8-mira@graumark.test',
    displayName: 'Mira Castellane',
    hero: 'Mira',
    classId: 'warrior',
    level: 1,
  },
} satisfies Record<string, SeedHero>;

export const PHASE8_GUILD = 'The Lantern Wardens';

const DAY = 86_400_000;
const REACH_PROGRESS: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 4,
  ashenWardenDefeated: true,
  forgeTyrantDefeated: true,
};

/** Cass's pack: what the search, the filters and the sort have to work with. */
const CASS_PACK: { rarityId: RarityId; locked?: boolean }[] = [
  ...Array<{ rarityId: RarityId }>(7).fill({ rarityId: 'common' }),
  ...Array<{ rarityId: RarityId }>(5).fill({ rarityId: 'uncommon' }),
  ...Array<{ rarityId: RarityId }>(3).fill({ rarityId: 'rare' }),
  { rarityId: 'epic', locked: true },
  { rarityId: 'epic' },
  { rarityId: 'legendary', locked: true },
];

export async function seedPhase8(app: FastifyInstance, db: Database, now: () => Date) {
  await app.ready();
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.email, PHASE8_PLAYERS.odric.email));
  if (existing) return;

  const passwordHash = await hashPassword(PHASE8_PASSWORD);
  const real = new Date();
  const made: Record<string, { id: string; characterId: string; sid: string; token: string }> = {};
  for (const [key, p] of Object.entries(PHASE8_PLAYERS) as [string, SeedHero][]) {
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
        .set({
          level: p.level,
          experience: 0,
          ...(p.level >= 40 ? { progress: REACH_PROGRESS } : {}),
        })
        .where(eq(characters.id, characterId));
    }
    made[key] = { id: account!.id, characterId, sid: session.sessionId, token: session.token };
  }
  const { odric, brynja, cass } = made as Record<
    keyof typeof PHASE8_PLAYERS,
    (typeof made)[string]
  >;

  // Odric: the Marches' top Legendaries +10, worn (as the Phase 8 journey tests seed them).
  await equipKit(db, odric!.characterId, 'warrior', 47, 'legendary', 'phase8');
  await db
    .update(itemInstances)
    .set({ upgradeLevel: 10 })
    .where(
      and(eq(itemInstances.characterId, odric!.characterId), isNotNull(itemInstances.equippedSlot)),
    );
  await equipKit(db, brynja!.characterId, 'hunter', 45, 'epic', 'phase8');
  await withTransaction(db, async (tx) => {
    const [hero] = await tx.select().from(characters).where(eq(characters.id, odric!.characterId));
    await changeGold(tx, hero!, 20_000, real);
  });
  await giveMaterials(db, odric!.characterId, { ironOre: 100, soulShard: 30 });

  // Cass's pack (game-core's generator at fixed seeds, like the 8.5 screenshots).
  const rng = createRng('phase8-exit:cass');
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= 20 && canClassUseItem(b, 'mage'),
  );
  for (const [i, p] of CASS_PACK.entries()) {
    const base = bases[rng.int(0, bases.length - 1)]!;
    const item = generateItem({
      seed: 8_700 + i,
      baseId: base.id,
      rarityId: p.rarityId,
      itemLevel: 18 + rng.int(0, 3),
      classId: 'mage',
    });
    if (!item) throw new Error(`seeding Cass's pack: no ${p.rarityId} ${base.id}`);
    await db.insert(itemInstances).values({
      id: uuidv7(real.getTime() - (CASS_PACK.length - i) * 60_000),
      characterId: cass!.characterId,
      baseId: item.baseId,
      rarityId: item.rarityId,
      itemLevel: item.itemLevel,
      affixes: item.affixes,
      seed: item.seed,
      ...itemEffectColumns(item),
      locked: p.locked ?? false,
      ...itemBindingColumns(item, 'farming', cass!.id),
      source: 'farming',
      createdAt: new Date(real.getTime() - (CASS_PACK.length - i) * 60_000),
    });
  }
  // Cass's Tavern: the story notice and three contracts taken through the route, three of the
  // four then made ready (their objectives filled in: test set-up).
  const call = (url: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      cookies: { [SESSION_COOKIE]: cass!.token },
    });
  await call(`/api/characters/${cass!.characterId}/quests`, {
    kind: 'story',
    questId: 'furrowsOfTheDead',
  });
  for (const slot of [0, 1, 2]) {
    await call(`/api/characters/${cass!.characterId}/quests`, { kind: 'contract', slot });
  }
  await db.execute(sql`
    update character_quests q set progress = (
      select jsonb_agg(coalesce((o->>'count')::int, 1)) from jsonb_array_elements(q.objectives) o)
    where q.id in (select id from character_quests where character_id = ${cass!.characterId}
      order by accepted_at, id limit 3)`);

  // The Lantern Wardens, founded ten days ago (members count on the roll after seven).
  await insertGuild(db, odric!.id, {
    name: PHASE8_GUILD,
    tag: 'LNW',
    members: [
      { accountId: brynja!.id, role: 'officer' },
      { accountId: cass!.id, role: 'member' },
    ],
    now: new Date(real.getTime() - 10 * DAY),
  });

  // The town's works, in order (each opens the next): the Lantern Vigil. Every account exists by
  // now, so each gets the stages' and eras' letters.
  for (const project of [
    'restoreWarehouse',
    'clearAshenPass',
    'forgewardOutpost',
    'deepLanterns',
  ]) {
    await completeProject(db, project, now());
  }
  app.worldState.invalidate();

  // Season 1 under way; the boards refreshed (the 5.2 sweep), so the roll has the members' parts.
  const start = now();
  await db.insert(seasons).values({
    number: 1,
    startsAt: new Date(start.getTime() - 10 * DAY),
    endsAt: new Date(start.getTime() + 18 * DAY),
  });
  await sweepLeaderboards(snapshotDeps(app), now(), { batch: 200, cursor: null });

  // A drop letter for Odric (the shape a settlement writes).
  await withTransaction(db, (tx) =>
    notifyDropsTx(tx, {
      accountId: odric!.id,
      characterId: odric!.characterId,
      source: 'farming',
      placeId: 'hollowDeep',
      items: [{ baseId: 'hollowsteel-greatblade', rarityId: 'legendary' }],
      now: now(),
    }),
  );

  await setAccountRole(db, PHASE8_PLAYERS.mira.email, 'admin');
  for (const who of Object.values(made)) await revokeSession(db, who.sid, new Date());
}
