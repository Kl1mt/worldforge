import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { MaterialId, ProjectResource } from '@worldforge/game-core';
import { SESSION_COOKIE } from '../auth/index.js';
import { characterMaterials, characters } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { insertCharacter } from './heroes.js';
import { insertAccount, type TestAccount } from './social.js';

/** Test helpers for community projects (ticket 4.6). */

export interface Patron {
  who: TestAccount;
  heroId: string;
}

/** An account with one hero holding `gold` and `materials`. */
export async function insertPatron(
  db: Database,
  { gold = 0, materials = {} }: { gold?: number; materials?: Partial<Record<MaterialId, number>> },
): Promise<Patron> {
  const who = await insertAccount(db);
  const hero = await insertCharacter(db, who.id, { level: 20 });
  await fund(db, hero.id, { gold, materials });
  return { who, heroId: hero.id };
}

export async function fund(
  db: Database,
  heroId: string,
  { gold = 0, materials = {} }: { gold?: number; materials?: Partial<Record<MaterialId, number>> },
): Promise<void> {
  if (gold) await db.update(characters).set({ gold }).where(eq(characters.id, heroId));
  const rows = Object.entries(materials).map(([materialId, quantity]) => ({
    characterId: heroId,
    materialId: materialId as MaterialId,
    quantity: quantity!,
  }));
  for (const row of rows) {
    await db
      .insert(characterMaterials)
      .values(row)
      .onConflictDoUpdate({
        target: [characterMaterials.characterId, characterMaterials.materialId],
        set: { quantity: row.quantity },
      });
  }
}

export function contributeCall(app: FastifyInstance) {
  return (
    p: Patron,
    projectId: string,
    stageId: string,
    offer: Partial<Record<ProjectResource, number>>,
    key: string = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/community/projects/${projectId}/contribute`,
      cookies: { [SESSION_COOKIE]: p.who.token },
      headers: { 'idempotency-key': key },
      payload: {
        characterId: p.heroId,
        stageId,
        offer: Object.entries(offer).map(([resource, amount]) => ({ resource, amount })),
      },
    });
}
