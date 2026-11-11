import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { NAME_SKELETON_VERSION, nameSkeleton, reservedNameMatch } from '@worldforge/game-core';
import { accounts, characters, dataBackfills, guilds, reservedNames } from '../db/schema.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * Look-alike and reserved names on the server (ticket 6.9, docs/SOCIAL.md "Look-alike and
 * reserved names"). Every new or changed display name, hero name and guild name goes through
 * `checkNewName` inside the transaction that writes it, after the shape rules (game-core
 * `validatePlayerText` / `validateCharacterName`):
 *
 * 1. its skeleton (game-core `nameSkeleton`) is locked for the kind (an advisory transaction lock),
 *    so two players choosing look-alike names at once are checked one after the other;
 * 2. it may not imitate a reserved name: the built-in `RESERVED_NAME_DEFAULTS` (staff, bosses, the
 *    town's people) or one the admins added (`reserved_names`);
 * 3. it may not share its skeleton with another existing name of the same kind (`409
 *    name_too_similar`). The same name in other letter case is left to the unique index (`409 …
 *    _taken`, as before);
 * 4. after a forced rename, it may not look like the name that was changed.
 *
 * The caller stores the returned skeleton with the name. Names taken before 6.9 are grandfathered:
 * they keep their names and are only compared against (their skeletons are backfilled at start).
 */
export type NameKind = 'displayName' | 'heroName' | 'guildName';

const RESERVED_MESSAGE = 'That name is reserved. Choose another.';
const SIMILAR: Record<NameKind, string> = {
  displayName: 'That name looks too much like another player’s. Choose another.',
  heroName: 'That name looks too much like another hero’s. Choose another.',
  guildName: 'That name looks too much like another guild’s. Choose another.',
};

export interface NameCheck {
  /** The field the error names (`displayName`, `name`). */
  field: string;
  /** The row whose name changes (its own current name never counts against it). */
  selfId?: string;
  /** After a forced rename: the name that was changed, which the new one may not resemble. */
  previous?: string | null;
}

/** Checks a new name (see above) and returns its skeleton to store. */
export async function checkNewName(
  tx: Transaction,
  kind: NameKind,
  name: string,
  check: NameCheck,
): Promise<string> {
  const skeleton = nameSkeleton(name);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`name-skeleton:${kind}:${skeleton}`}, 0))`,
  );
  const fail = (status: 400 | 409, code: string, message: string): never => {
    throw new ApiError(status, code, message, { fields: { [check.field]: message } });
  };
  const extra = await tx.select({ name: reservedNames.name }).from(reservedNames);
  if (
    reservedNameMatch(
      name,
      extra.map((r) => r.name),
    )
  ) {
    fail(400, 'validation_failed', RESERVED_MESSAGE);
  }
  if (check.previous && nameSkeleton(check.previous) === skeleton) {
    fail(400, 'validation_failed', 'Choose a different name from the one that was changed.');
  }
  if (await skeletonTaken(tx, kind, name, skeleton, check.selfId)) {
    fail(409, 'name_too_similar', SIMILAR[kind]);
  }
  return skeleton;
}

async function skeletonTaken(
  tx: Executor,
  kind: NameKind,
  name: string,
  skeleton: string,
  selfId: string | undefined,
): Promise<boolean> {
  if (kind === 'displayName') {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.displayNameSkeleton, skeleton),
          sql`lower(${accounts.displayName}) <> lower(${name})`,
          selfId ? ne(accounts.id, selfId) : undefined,
        ),
      )
      .limit(1);
    return !!row;
  }
  if (kind === 'heroName') {
    const [row] = await tx
      .select({ id: characters.id })
      .from(characters)
      .where(
        and(
          eq(characters.nameSkeleton, skeleton),
          sql`lower(${characters.name}) <> lower(${name})`,
          selfId ? ne(characters.id, selfId) : undefined,
        ),
      )
      .limit(1);
    return !!row;
  }
  const [row] = await tx
    .select({ id: guilds.id })
    .from(guilds)
    .where(
      and(
        eq(guilds.nameSkeleton, skeleton),
        isNull(guilds.disbandedAt),
        sql`lower(${guilds.name}) <> lower(${name})`,
        selfId ? ne(guilds.id, selfId) : undefined,
      ),
    )
    .limit(1);
  return !!row;
}

export const NAME_SKELETON_BACKFILL_ID = `name-skeletons:v${NAME_SKELETON_VERSION}`;
const BATCH = 500;

/**
 * Fills the skeleton of every name taken before 6.9 (and recomputes all of them when the skeleton
 * rules change: a new `NAME_SKELETON_VERSION`, a new backfill id). Idempotent and resumable: it
 * walks each table by id; once done it is recorded in `data_backfills` and never runs again. Run
 * by the server after start-up, on the instance that leads the start-up backfills.
 */
export async function backfillNameSkeletons(
  db: Database,
): Promise<{ id: string; ran: boolean; updated: number }> {
  const [done] = await db
    .select()
    .from(dataBackfills)
    .where(eq(dataBackfills.id, NAME_SKELETON_BACKFILL_ID));
  if (done) return { id: NAME_SKELETON_BACKFILL_ID, ran: false, updated: 0 };
  let updated = 0;
  const tables = [
    { t: accounts, id: accounts.id, name: accounts.displayName, sk: accounts.displayNameSkeleton },
    { t: characters, id: characters.id, name: characters.name, sk: characters.nameSkeleton },
    { t: guilds, id: guilds.id, name: guilds.name, sk: guilds.nameSkeleton },
  ] as const;
  for (const { t, id, name, sk } of tables) {
    let after: string | null = null;
    for (;;) {
      const rows: { id: string; name: string; sk: string | null }[] = await db
        .select({ id, name, sk })
        .from(t)
        .where(after ? sql`${id} > ${after}` : isNotNull(id))
        .orderBy(asc(id))
        .limit(BATCH);
      if (rows.length === 0) break;
      for (const r of rows) {
        const s = nameSkeleton(r.name);
        if (r.sk === s) continue;
        // Only if the name is still the one read (a rename in between wrote its own skeleton).
        await db
          .update(t)
          .set({ [t === accounts ? 'displayNameSkeleton' : 'nameSkeleton']: s })
          .where(and(eq(id, r.id), eq(name, r.name)));
        updated += 1;
      }
      after = rows[rows.length - 1]!.id;
    }
  }
  await db
    .insert(dataBackfills)
    .values({ id: NAME_SKELETON_BACKFILL_ID, completedAt: new Date(), data: { updated } })
    .onConflictDoNothing();
  return { id: NAME_SKELETON_BACKFILL_ID, ran: true, updated };
}
