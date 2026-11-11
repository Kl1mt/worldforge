import { and, asc, count, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { validateCharacterName } from '@worldforge/game-core';
import {
  accounts,
  activities,
  characters,
  duelDefences,
  duelOffers,
  leaderboardEntries,
  type Account,
  type Character,
  type HeroDeletionState,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Transaction } from '../db/types.js';
import { checkNewName } from '../names/checks.js';
import { ApiError } from '../errors.js';
import { endActivityTx, type ActivityOptions } from '../activity/settle.js';
import { lockOwnedCharacter } from '../inventory/routes.js';
import { lockShelf } from '../shelf/routes.js';
import { rehomeShelfItemsForDeletion } from '../shelf/deletion.js';
import { voidForDeletion } from '../trading/offers.js';
import { RESTORE_WINDOW_MS } from './inspector.js';
import {
  adminAudit,
  assertConfirmed,
  lockAdmin,
  lockTargetAccount,
  targetAccount,
} from './tools.js';

/**
 * Hero deletion (ticket D.4, docs/TRADING.md "Hero deletion"): a **soft delete** with a 14-day
 * restore window, then a CLI-only purge.
 *
 * **Lock order** (the shelf's and T.5's): the account's shelf lock, the target account row
 * `for no key update` (a trade write holds it `for share` first, so a deletion and an accept, a send or a
 * shelf move serialise there), the admin's row `for share` (the role re-read), then T.5's
 * `voidForDeletion` (offer rows, then heroes, then items: escrow goes back to each sender), the
 * hero itself (settling its activity one last time), then the shelf seam (`rehome…`: other heroes,
 * items). Everything happens in one transaction: all of it, or none.
 *
 * What a soft delete does: settles and ends the hero's activity (frozen: nothing farms for it),
 * voids its open offers (escrow returns), hands its shelf items to another hero of the account
 * (T.7's rule: refused with `409 shelf_not_empty` when there is none), withdraws its arena
 * defence and any drawn opponent list, removes its leaderboard rows, clears it as the account's
 * active and showcase hero, and marks it. Every read path hides a deleted hero (`deleted_at is
 * null`, guarded by `soft-delete.test.ts`), and the boards' read-time rule leaves its season and
 * arena rows out. **Guilds** belong to accounts, not heroes, so a deletion never touches a guild
 * role: a guild leader stays leader (nothing to hand over).
 */

export interface DeleteHeroInput {
  adminId: string;
  handle: string;
  characterId: string;
  confirm: string;
  reason: string;
}

const heroSummary = (h: Character) => ({
  name: h.name,
  classId: h.classId,
  level: h.level,
  gold: h.gold,
});

export async function softDeleteHero(
  tx: Transaction,
  input: DeleteHeroInput,
  activity: ActivityOptions,
  authNow: Date,
) {
  const { id: accountId } = await targetAccount(tx, input.handle);
  await lockShelf(tx, accountId);
  const account = await lockTargetAccount(tx, input.handle);
  await lockAdmin(tx, input.adminId);
  const [peek] = await tx
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.id, input.characterId),
        eq(characters.accountId, account.id),
        isNull(characters.deletedAt),
      ),
    );
  if (!peek) throw new ApiError(404, 'not_found', 'No such hero.');
  assertConfirmed(peek.name, input.confirm);

  // T.5's seam first: offer rows before hero rows (its lock order).
  const offersVoided = await voidForDeletion(tx, peek.id, authNow, activity);
  // The hero, settled one last time (its farming so far is credited), then frozen.
  const hero = await lockOwnedCharacter(tx, account.id, peek.id, activity);
  const [running] = await tx.select().from(activities).where(eq(activities.characterId, hero.id));
  if (running) await endActivityTx(tx, running);
  // T.7's seam: shelf items go to another hero of the account (or the deletion is refused).
  const shelfItemsRehomed = await rehomeShelfItemsForDeletion(tx, account.id, hero.id, authNow);
  const [defence] = await tx
    .delete(duelDefences)
    .where(eq(duelDefences.characterId, hero.id))
    .returning();
  await tx.delete(duelOffers).where(eq(duelOffers.characterId, hero.id));
  const removedRows = await tx
    .delete(leaderboardEntries)
    .where(eq(leaderboardEntries.characterId, hero.id))
    .returning({ metric: leaderboardEntries.metric });
  const wasActive = account.activeCharacterId === hero.id;
  const wasShowcase = account.showcaseCharacterId === hero.id;
  if (wasActive || wasShowcase) {
    await tx
      .update(accounts)
      .set({
        ...(wasActive ? { activeCharacterId: null } : {}),
        ...(wasShowcase ? { showcaseCharacterId: null } : {}),
        updatedAt: authNow,
      })
      .where(eq(accounts.id, account.id));
  }
  const deletion: HeroDeletionState = {
    defence: defence ? (JSON.parse(JSON.stringify(defence)) as Record<string, unknown>) : null,
    wasActive,
    wasShowcase,
    activityAreaId: running?.areaId ?? null,
    offersVoided,
    shelfItemsRehomed,
    leaderboardRowsRemoved: removedRows.length,
  };
  await tx
    .update(characters)
    .set({
      deletedAt: authNow,
      deletedBy: input.adminId,
      deleteReason: input.reason.trim(),
      deletion,
      version: sql`${characters.version} + 1`,
      updatedAt: authNow,
    })
    .where(eq(characters.id, hero.id));
  const restoreUntil = new Date(authNow.getTime() + RESTORE_WINDOW_MS).toISOString();
  await adminAudit(tx, {
    event: 'admin.hero.delete',
    adminId: input.adminId,
    target: account,
    characterId: hero.id,
    reason: input.reason,
    before: { ...heroSummary(hero), deleted: false },
    after: { deleted: true, restoreUntil },
    data: {
      offersVoided,
      shelfItemsRehomed,
      defenceWithdrawn: defence !== undefined,
      activityEnded: running !== undefined,
      leaderboardRowsRemoved: removedRows.length,
    },
  });
  return { characterId: hero.id, name: hero.name, restoreUntil, ...deletion, defence: !!defence };
}

/** Dates in a JSON round trip of a row: keys ending in `At` back to `Date`. */
function revive(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      k.endsWith('At') && typeof v === 'string' ? new Date(v) : v,
    ]),
  );
}

/**
 * Restores a soft-deleted hero within the window. Brings back what can come back: the hero, its
 * arena defence (as it was saved, if the hero has none now), the active and showcase choice (if
 * the account has none now); its leaderboard rows are recomputed right after (the route) and its
 * season and arena rows reappear. What stays: voided offers (their escrow went back), shelf items
 * handed to another hero (still on the account's shelf), the ended activity (the player starts
 * farming again; its seed stream continues), an opponent list it had drawn.
 */
export async function restoreHero(
  tx: Transaction,
  input: Omit<DeleteHeroInput, 'confirm'>,
  authNow: Date,
) {
  const account = await lockTargetAccount(tx, input.handle);
  await lockAdmin(tx, input.adminId);
  const [hero] = await tx
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.id, input.characterId),
        eq(characters.accountId, account.id),
        isNotNull(characters.deletedAt),
      ),
    )
    .for('no key update');
  if (!hero || !hero.deletedAt)
    throw new ApiError(404, 'not_found', 'No deleted hero with that id.');
  const until = hero.deletedAt.getTime() + RESTORE_WINDOW_MS;
  if (authNow.getTime() >= until) {
    throw new ApiError(
      409,
      'restore_window_passed',
      'The 14-day restore window has passed; the hero waits for the purge.',
      { restoreUntil: new Date(until).toISOString() },
    );
  }
  const [used] = await tx
    .select({ n: count() })
    .from(characters)
    .where(and(eq(characters.accountId, account.id), isNull(characters.deletedAt)));
  if ((used?.n ?? 0) >= account.characterSlots) {
    throw new ApiError(409, 'no_free_slot', 'Every hero slot of this account is taken.', {
      slots: { used: used?.n ?? 0, total: account.characterSlots },
    });
  }
  const state = hero.deletion;
  await tx
    .update(characters)
    .set({
      deletedAt: null,
      deletedBy: null,
      deleteReason: null,
      deletion: null,
      version: sql`${characters.version} + 1`,
      updatedAt: authNow,
    })
    .where(eq(characters.id, hero.id));
  let defenceRestored = false;
  if (state?.defence) {
    const [existing] = await tx
      .select({ id: duelDefences.id })
      .from(duelDefences)
      .where(eq(duelDefences.characterId, hero.id));
    if (!existing) {
      await tx
        .insert(duelDefences)
        .values(revive(state.defence) as typeof duelDefences.$inferInsert)
        .onConflictDoNothing();
      defenceRestored = true;
    }
  }
  const patch: Partial<Account> = {};
  if (state?.wasActive && account.activeCharacterId === null) patch.activeCharacterId = hero.id;
  if (state?.wasShowcase && account.showcaseCharacterId === null) {
    patch.showcaseCharacterId = hero.id;
  }
  if (Object.keys(patch).length > 0) {
    await tx
      .update(accounts)
      .set({ ...patch, updatedAt: authNow })
      .where(eq(accounts.id, account.id));
  }
  await adminAudit(tx, {
    event: 'admin.hero.restore',
    adminId: input.adminId,
    target: account,
    characterId: hero.id,
    reason: input.reason,
    before: { deleted: true, deletedAt: hero.deletedAt.toISOString() },
    after: { ...heroSummary(hero), deleted: false },
    data: {
      defenceRestored,
      activeRestored: patch.activeCharacterId !== undefined,
      showcaseRestored: patch.showcaseCharacterId !== undefined,
      notRestored: {
        offersVoided: state?.offersVoided ?? 0,
        shelfItemsRehomed: state?.shelfItemsRehomed ?? 0,
        activityAreaId: state?.activityAreaId ?? null,
      },
    },
  });
  return {
    characterId: hero.id,
    name: hero.name,
    defenceRestored,
    activeRestored: patch.activeCharacterId !== undefined,
    showcaseRestored: patch.showcaseCharacterId !== undefined,
    notRestored: {
      offersVoided: state?.offersVoided ?? 0,
      shelfItemsRehomed: state?.shelfItemsRehomed ?? 0,
      activityAreaId: state?.activityAreaId ?? null,
    },
  };
}

/** Renames a hero (moderation). The new name follows the player rules and must be free. */
export async function renameHero(
  tx: Transaction,
  input: { adminId: string; handle: string; characterId: string; name: string; reason: string },
  authNow: Date,
) {
  const account = await targetAccount(tx, input.handle);
  await lockAdmin(tx, input.adminId);
  const checked = validateCharacterName(input.name);
  if (!checked.ok) {
    throw new ApiError(400, 'validation_failed', checked.message, {
      fields: { name: checked.message },
    });
  }
  const [hero] = await tx
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.id, input.characterId),
        eq(characters.accountId, account.id),
        isNull(characters.deletedAt),
      ),
    )
    .for('no key update');
  if (!hero) throw new ApiError(404, 'not_found', 'No such hero.');
  if (hero.name === checked.name) {
    throw new ApiError(409, 'unchanged', 'The hero already has this name.');
  }
  const [taken] = await tx
    .select({ id: characters.id })
    .from(characters)
    .where(and(sql`lower(${characters.name}) = lower(${checked.name})`));
  if (taken && taken.id !== hero.id) {
    throw new ApiError(409, 'name_taken', 'Another hero already has this name.');
  }
  // Ticket 6.9: the same look-alike and reserved-name rules as players get.
  const nameSkeleton = await checkNewName(tx, 'heroName', checked.name, {
    field: 'name',
    selfId: hero.id,
  });
  await tx
    .update(characters)
    .set({ name: checked.name, nameSkeleton, updatedAt: authNow })
    .where(eq(characters.id, hero.id));
  await adminAudit(tx, {
    event: 'admin.hero.rename',
    adminId: input.adminId,
    target: account,
    characterId: hero.id,
    reason: input.reason,
    before: { name: hero.name },
    after: { name: checked.name },
  });
  return { characterId: hero.id, from: hero.name, to: checked.name };
}

export interface PurgeOutcome {
  purged: { characterId: string; name: string }[];
  kept: { characterId: string; name: string; why: string }[];
}

/** `restrict` keys raise 23001, `no action` keys 23503. */
const FK_CODES = new Set(['23001', '23503']);

/**
 * The CLI's purge (`pnpm admin:tools purge`): deletes heroes soft-deleted more than 14 days ago,
 * one transaction each, through both deletion seams again (no-ops by then: a deleted hero is
 * frozen). A hero that trade history still names (T.5 keeps every offer, and its foreign keys
 * refuse) stays soft-deleted for good and is reported as kept. `dryRun` lists without deleting.
 */
export async function purgeDeletedHeroes(
  db: Database,
  now: Date,
  activity: ActivityOptions,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<PurgeOutcome> {
  const due = await db
    .select({ id: characters.id, name: characters.name, accountId: characters.accountId })
    .from(characters)
    .where(lt(characters.deletedAt, new Date(now.getTime() - RESTORE_WINDOW_MS)))
    .orderBy(asc(characters.deletedAt), asc(characters.id));
  const out: PurgeOutcome = { purged: [], kept: [] };
  for (const hero of due) {
    if (dryRun) {
      out.purged.push({ characterId: hero.id, name: hero.name });
      continue;
    }
    try {
      await withTransaction(db, async (tx) => {
        await lockShelf(tx, hero.accountId);
        await tx.execute(
          sql`select 1 from accounts where id = ${hero.accountId} for no key update`,
        );
        await voidForDeletion(tx, hero.id, now, activity);
        await rehomeShelfItemsForDeletion(tx, hero.accountId, hero.id, now);
        const gone = await tx
          .delete(characters)
          .where(and(eq(characters.id, hero.id), isNotNull(characters.deletedAt)))
          .returning({ id: characters.id });
        if (gone.length === 0) return;
        await writeAudit(tx, {
          event: 'admin.hero.purge',
          accountId: hero.accountId,
          data: { characterId: hero.id, name: hero.name, via: 'cli' },
        });
      });
      out.purged.push({ characterId: hero.id, name: hero.name });
    } catch (err) {
      const code =
        (err as { code?: string; cause?: { code?: string } }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      const why =
        code !== undefined && FK_CODES.has(code)
          ? 'named in trade history (kept soft-deleted for the audit trail)'
          : err instanceof ApiError
            ? err.message
            : 'failed';
      if (!(code !== undefined && FK_CODES.has(code)) && !(err instanceof ApiError)) throw err;
      out.kept.push({ characterId: hero.id, name: hero.name, why });
    }
  }
  return out;
}
