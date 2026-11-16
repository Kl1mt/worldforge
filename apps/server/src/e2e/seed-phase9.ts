import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { shrineOutcome, type ClassId, type WorldProgress } from '@worldforge/game-core';
import { SESSION_COOKIE, createSession, hashPassword, revokeSession } from '../auth/index.js';
import { grantAccountGrowthTx } from '../account-growth/grant.js';
import { accounts, characters, itemInstances } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { drawTx } from '../shrine/model.js';
import { equipKit } from '../test/arena.js';
import { giveMaterials } from '../test/trading.js';

/**
 * Test-only seed for the Phase 9 browser run (ticket 9.6, `tools/e2e/phase9-exit.mjs`), started by
 * `E2E_SEED_PHASE9=1` on the e2e server (`serve.ts`, which refuses `NODE_ENV=production`). It sets
 * up, through the database and the server's own model functions and test fixtures, what weeks of
 * play would otherwise provide; the flows themselves run through the real UI:
 * - two accounts (password `ashes-and-iron-42`, `@graumark.test`, email verified, a month old,
 *   guide dismissed), each with a hero made through the character route, then set up:
 *   - **Aud Morrowgrave** (`p9-aud@`, Warlock "Aud", level 30, the Gravewarden behind her): Rares
 *     of item level 29 worn; every warlock skill up to level 30 open to her, the default loadout in
 *     force, no duel defence yet;
 *   - **Torvald Emberhand** (`p9-torvald@`, Warrior "Torvald", level 38, the Phase 6 bosses behind
 *     him: the Gravewarden, crypt tier III, the Ashen Warden, the Forge Tyrant): Legendaries 33 +10
 *     worn; the Tyrant's Lesson taken through the route and its fresh Tyrant kill filled in (test
 *     set-up), two Gravewarden's Seals in his stack, so the turn-in is ready; his account's deeds
 *     granted by the server's grant function (the third slot, four offline steps: 8 hours); one
 *     Shrine draw drawn with a seed game-core shows drawing a companion (the rest of his free bank
 *     waits: 6 draws).
 * Nothing is seeded when Aud already exists (a kept `E2E_DATA_DIR` database). The setup sessions are
 * revoked at the end.
 */

export const PHASE9_PASSWORD = 'ashes-and-iron-42';

interface SeedHero {
  email: string;
  displayName: string;
  hero: string;
  classId: ClassId;
  level: number;
}

export const PHASE9_PLAYERS = {
  aud: {
    email: 'p9-aud@graumark.test',
    displayName: 'Aud Morrowgrave',
    hero: 'Aud',
    classId: 'warlock',
    level: 30,
  },
  torvald: {
    email: 'p9-torvald@graumark.test',
    displayName: 'Torvald Emberhand',
    hero: 'Torvald',
    classId: 'warrior',
    level: 38,
  },
} satisfies Record<string, SeedHero>;

const DAY = 86_400_000;
const AUD_PROGRESS: WorldProgress = { gravewardenDefeated: true, cryptTierCleared: 1 };
const TORVALD_PROGRESS: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 3,
  ashenWardenDefeated: true,
  forgeTyrantDefeated: true,
};

/** A Shrine seed game-core's own rule shows drawing a companion for an account owning none. */
export function phase9CompanionSeed(): string {
  for (let n = 0; n < 10_000; n++) {
    const seed = `phase9-seed-companion-${n}`;
    if (shrineOutcome(seed, new Set()).cosmeticId.startsWith('companion.')) return seed;
  }
  throw new Error('no companion seed in 10,000');
}

export async function seedPhase9(app: FastifyInstance, db: Database, now: () => Date) {
  await app.ready();
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.email, PHASE9_PLAYERS.aud.email));
  if (existing) return;

  const passwordHash = await hashPassword(PHASE9_PASSWORD);
  const real = new Date();
  const made: Record<string, { id: string; characterId: string; sid: string; token: string }> = {};
  for (const [key, p] of Object.entries(PHASE9_PLAYERS) as [string, SeedHero][]) {
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
    await db
      .update(characters)
      .set({
        level: p.level,
        experience: 0,
        progress: key === 'torvald' ? TORVALD_PROGRESS : AUD_PROGRESS,
      })
      .where(eq(characters.id, characterId));
    made[key] = { id: account!.id, characterId, sid: session.sessionId, token: session.token };
  }
  const { aud, torvald } = made as Record<keyof typeof PHASE9_PLAYERS, (typeof made)[string]>;

  // Aud: Rares 29. Torvald: the Tyrant job's kit (Legendaries 33 +10, docs/SKILLS.md).
  await equipKit(db, aud!.characterId, 'warlock', 29, 'rare', 'phase9');
  await equipKit(db, torvald!.characterId, 'warrior', 33, 'legendary', 'phase9');
  await db
    .update(itemInstances)
    .set({ upgradeLevel: 10 })
    .where(
      and(
        eq(itemInstances.characterId, torvald!.characterId),
        isNotNull(itemInstances.equippedSlot),
      ),
    );

  // Torvald's lesson: taken through the route, its fresh kill filled in (test set-up), the Seals.
  const took = await app.inject({
    method: 'POST',
    url: `/api/characters/${torvald!.characterId}/quests`,
    payload: { kind: 'skill', questId: 'theTyrantsLesson' },
    cookies: { [SESSION_COOKIE]: torvald!.token },
  });
  if (took.statusCode !== 201) throw new Error(`seeding the lesson failed: ${took.body}`);
  await db.execute(sql`
    update character_quests q set progress = (
      select jsonb_agg(coalesce((o->>'count')::int, 1)) from jsonb_array_elements(q.objectives) o)
    where q.character_id = ${torvald!.characterId} and q.kind = 'skill'`);
  await giveMaterials(db, torvald!.characterId, { gravewardenSeal: 2 });

  // Torvald's deeds, granted by the server's own grant function (as a dungeon claim would).
  await withTransaction(db, (tx) =>
    grantAccountGrowthTx(
      tx,
      {
        id: torvald!.characterId,
        accountId: torvald!.id,
        level: PHASE9_PLAYERS.torvald.level,
        progress: TORVALD_PROGRESS,
      },
      now(),
    ),
  );
  // One Shrine draw, pinned to a companion (the model's own draw with a chosen seed).
  await withTransaction(db, (tx) => drawTx(tx, torvald!.id, now(), phase9CompanionSeed()));

  for (const who of Object.values(made)) await revokeSession(db, who.sid, new Date());
}
