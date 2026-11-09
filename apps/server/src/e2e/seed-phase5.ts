import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_TRADING_SETTINGS, type ClassId } from '@worldforge/game-core';
import { SESSION_COOKIE, createSession, hashPassword, revokeSession } from '../auth/index.js';
import { completeProject } from '../community/project-cli.js';
import { accounts, characters } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import { changeGold } from '../economy/shared.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { scheduleSeason } from '../seasons/model.js';
import { equipKit } from '../test/arena.js';
import { befriendSince, insertTradeItem, setTradingSettings } from '../test/trading.js';

/**
 * Test-only seed for the Phase 5 browser run (ticket 5.8, `tools/e2e/phase5-exit.mjs`), started by
 * `E2E_SEED_PHASE5=1` on the e2e server (`serve.ts`, which refuses `NODE_ENV=production`). It sets
 * up, directly through the database and the server's own model functions, what the owner and time
 * would otherwise provide; the flows themselves (sending and accepting an offer, duels, boards,
 * verification, reset) run through the real UI and API:
 * - trading open: the master switch, Trade and Shelf for items, materials and gold (the test
 *   fixture `setTradingSettings`; the save function needs an admin as its actor), the categories
 *   at their defaults (Epic, Legendary and set pieces);
 * - the Warehouse restored (the owner's `admin:project complete restoreWarehouse`), for the shelf;
 * - Season 1 scheduled from now for 8 weeks (`scheduleSeason`, `via: 'cli'`, on the game clock);
 * - three players (password `ashes-and-iron-42`, `@graumark.test`, guide dismissed), each with a
 *   hero made through the character route, then levelled in the database:
 *   - **Ilse Varrow** (`p5-ilse@`, Warrior "Ilse", level 15, 1,200 gold, a rare level-15 kit worn
 *     and a fresh tradeable Epic longsword in the pack) and **Bertram Holt** (`p5-bertram@`, Hunter
 *     "Bertram", level 16, 300 gold, a saved defence): trade-ready (account created 30 days ago,
 *     email verified, friends for 30 days; trading reads the real clock);
 *   - **Corvin Ashe** (`p5-corvin@`, Warrior "Corvin", level 15, the same kit as Ilse so the two
 *     are matched within the Power range, a saved defence): a stranger to Ilse, so the server
 *     offers him for her rated duel; Bertram (her friend) is for a friendly challenge.
 * The setup sessions are revoked at the end. Nothing is seeded when Ilse already exists (a kept
 * `E2E_DATA_DIR` database).
 */

export const PHASE5_PASSWORD = 'ashes-and-iron-42';

interface SeedHero {
  email: string;
  displayName: string;
  hero: string;
  classId: ClassId;
  level: number;
  gold: number;
}

export const PHASE5_PLAYERS = {
  ilse: {
    email: 'p5-ilse@graumark.test',
    displayName: 'Ilse Varrow',
    hero: 'Ilse',
    classId: 'warrior',
    level: 15,
    gold: 1_200,
  },
  bertram: {
    email: 'p5-bertram@graumark.test',
    displayName: 'Bertram Holt',
    hero: 'Bertram',
    classId: 'hunter',
    level: 16,
    gold: 300,
  },
  corvin: {
    email: 'p5-corvin@graumark.test',
    displayName: 'Corvin Ashe',
    hero: 'Corvin',
    classId: 'warrior',
    level: 15,
    gold: 0,
  },
} satisfies Record<string, SeedHero>;

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export async function seedPhase5(app: FastifyInstance, db: Database, now: () => Date) {
  await app.ready();
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.email, PHASE5_PLAYERS.ilse.email));
  if (existing) return;

  await setTradingSettings(app, db, {
    ...structuredClone(DEFAULT_TRADING_SETTINGS),
    trading: true,
    trade: { items: true, materials: true, gold: true },
    shelf: { items: true, materials: true, gold: true },
  });
  await completeProject(db, 'restoreWarehouse', now());
  app.worldState.invalidate();
  const start = now();
  await scheduleSeason(
    db,
    { startsAt: start, endsAt: new Date(start.getTime() + 8 * WEEK) },
    start,
    {
      accountId: null,
      via: 'cli',
    },
  );

  const passwordHash = await hashPassword(PHASE5_PASSWORD);
  const real = new Date();
  const made: Record<string, { id: string; characterId: string; token: string; sid: string }> = {};
  for (const [key, p] of Object.entries(PHASE5_PLAYERS) as [string, SeedHero][]) {
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
    const cookies = { [SESSION_COOKIE]: session.token };
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { name: p.hero, classId: p.classId, appearance: { banner: 'ember' } },
      cookies,
    });
    if (res.statusCode !== 201) throw new Error(`seeding ${p.hero} failed: ${res.body}`);
    const characterId = res.json<{ character: { id: string } }>().character.id;
    await db.update(characters).set({ level: p.level }).where(eq(characters.id, characterId));
    // Gold through the one gold writer (the spend-path guard in trading/holds.test.ts).
    if (p.gold > 0) {
      await withTransaction(db, async (tx) => {
        const [hero] = await tx.select().from(characters).where(eq(characters.id, characterId));
        await changeGold(tx, hero!, p.gold, real);
      });
    }
    made[key] = { id: account!.id, characterId, token: session.token, sid: session.sessionId };
  }
  const { ilse, bertram, corvin } = made as Record<
    keyof typeof PHASE5_PLAYERS,
    (typeof made)[string]
  >;

  // The same kit for both warriors (same tag): equal bracket Power, so the matchmaking pairs them.
  await equipKit(db, ilse!.characterId, 'warrior', 15, 'rare', 'phase5');
  await equipKit(db, corvin!.characterId, 'warrior', 15, 'rare', 'phase5');
  await insertTradeItem(db, ilse!.characterId);
  await befriendSince(
    db,
    { id: ilse!.id, handle: '', displayName: '', token: '', role: 'player' },
    { id: bertram!.id, handle: '', displayName: '', token: '', role: 'player' },
    real,
    30,
  );
  for (const who of [bertram!, corvin!]) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/arena/defence',
      payload: { characterId: who.characterId },
      cookies: { [SESSION_COOKIE]: who.token },
    });
    if (res.statusCode !== 200) throw new Error(`seeding a defence failed: ${res.body}`);
  }
  for (const who of [ilse!, bertram!, corvin!]) await revokeSession(db, who.sid, new Date());
}
