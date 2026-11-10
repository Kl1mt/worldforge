import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  CONTRACTS_PER_DAY,
  contractDay,
  duelDay,
  merchantDay,
  type AccountRole,
  type TradingSwitches,
} from '@worldforge/game-core';
import {
  accountShelfMaterials,
  accounts,
  activities,
  auditLog,
  characterMaterials,
  characterProfessions,
  characterQuests,
  characters,
  duelDefences,
  duels,
  itemInstances,
  merchantPurchases,
  sanctions,
  sessions,
  tradeHolds,
  tradeOffers,
  type Account,
  type Character,
  type ItemInstance,
} from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { itemView, type ItemView } from '../inventory/routes.js';
import { scrubAuditData } from './tools.js';

/**
 * The admin player inspector (ticket D.4): everything support and testing need about one account
 * on one page. Never the email or anything about the password: only "verified yes/no". Read-only;
 * the route audits the view.
 */

/** A soft-deleted hero can be restored this long after its deletion; then `purge` removes it. */
export const RESTORE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const AUDIT_LIMIT = 60;

export type ItemLocation = 'pack' | 'equipped' | 'warehouse' | 'shelf' | 'escrow';

export interface AdminItemView extends ItemView {
  location: ItemLocation;
  /** Who holds it: the hero's id (a shelf item: the hero who placed it). */
  characterId: string;
  /** Why an admin removal would be refused right now (held, escrowed), or null. */
  removeBlocked: 'held' | 'escrow' | null;
}

export function itemLocation(i: ItemInstance): ItemLocation {
  if (i.escrowOfferId) return 'escrow';
  if (i.onShelf) return 'shelf';
  if (i.inWarehouse) return 'warehouse';
  if (i.equippedSlot) return 'equipped';
  return 'pack';
}

export function adminItemView(
  i: ItemInstance,
  switches: Readonly<TradingSwitches>,
  now: Date,
): AdminItemView {
  const held = i.holdUntil !== null && i.holdUntil.getTime() > now.getTime();
  return {
    ...itemView(i, switches),
    location: itemLocation(i),
    characterId: i.characterId,
    removeBlocked: i.escrowOfferId ? 'escrow' : held ? 'held' : null,
  };
}

export interface HeroFile {
  id: string;
  name: string;
  classId: string;
  level: number;
  experience: number;
  gold: number;
  progress: Character['progress'];
  warehouseLevel: number;
  createdAt: string;
  deleted: { at: string; restoreUntil: string; reason: string; restorable: boolean } | null;
  activity: { areaId: string; settledAt: string; lastSeenAt: string } | null;
  materials: Record<string, number>;
  professions: { professionId: string; level: number; experience: number }[];
  items: AdminItemView[];
  quests: {
    id: string;
    kind: string;
    questId: string;
    status: string;
    contractDay: string | null;
    progress: number[];
    objectives: unknown[];
  }[];
  defence: { bracketId: string; level: number } | null;
  holds: { gold: number; materials: Record<string, number>; items: number; heldUntil: string }[];
  daily: { ratedDuels: number; contracts: number; contractsPerDay: number; merchantBought: number };
}

export interface AccountFile {
  handle: string;
  displayName: string;
  role: AccountRole;
  createdAt: string;
  testAccount: boolean;
  emailVerified: boolean;
  characterSlots: number;
  sessions: number;
  loginLockedForMs: number;
  shelf: { gold: number; materials: Record<string, number>; items: AdminItemView[] };
  heroes: HeroFile[];
  sanctions: {
    id: string;
    kind: string;
    reason: string;
    createdAt: string;
    expiresAt: string;
    liftedAt: string | null;
    active: boolean;
  }[];
  offers: {
    id: string;
    direction: 'sent' | 'received';
    counterpart: { handle: string; displayName: string } | null;
    status: string;
    expiresAt: string;
    createdAt: string;
  }[];
  audit: { id: string; event: string; at: string; heroName: string | null; data: unknown }[];
  /** True when this is the viewing admin's own account (cheat tools warn: public boards). */
  own: boolean;
}

const bundle = (rows: { materialId: string; quantity: number }[]) =>
  Object.fromEntries(rows.filter((r) => r.quantity > 0).map((r) => [r.materialId, r.quantity]));

/** One hero's file (items in every location, materials, quests, limits, holds). */
export async function heroFile(
  db: Executor,
  hero: Character,
  switches: Readonly<TradingSwitches>,
  now: Date,
  authNow: Date,
): Promise<HeroFile> {
  const [items, mats, profs, quests, [activity], [defence], holds, [duelRow], [bought]] =
    await Promise.all([
      db
        .select()
        .from(itemInstances)
        .where(
          and(
            eq(itemInstances.characterId, hero.id),
            // Shelf items show on the account's shelf, not under the hero who placed them.
            eq(itemInstances.onShelf, false),
          ),
        )
        .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id)),
      db
        .select({
          materialId: characterMaterials.materialId,
          quantity: characterMaterials.quantity,
        })
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, hero.id)),
      db
        .select({
          professionId: characterProfessions.professionId,
          level: characterProfessions.level,
          experience: characterProfessions.experience,
        })
        .from(characterProfessions)
        .where(eq(characterProfessions.characterId, hero.id))
        .orderBy(asc(characterProfessions.professionId)),
      db
        .select()
        .from(characterQuests)
        .where(eq(characterQuests.characterId, hero.id))
        .orderBy(desc(characterQuests.acceptedAt))
        .limit(40),
      db.select().from(activities).where(eq(activities.characterId, hero.id)),
      db
        .select({ bracketId: duelDefences.bracketId, level: duelDefences.level })
        .from(duelDefences)
        .where(eq(duelDefences.characterId, hero.id)),
      db
        .select()
        .from(tradeHolds)
        .where(
          and(
            eq(tradeHolds.characterId, hero.id),
            isNull(tradeHolds.releasedAt),
            gt(tradeHolds.heldUntil, authNow),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(duels)
        .where(
          and(
            eq(duels.challengerCharacterId, hero.id),
            eq(duels.day, duelDay(now)),
            eq(duels.kind, 'rated'),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(merchantPurchases)
        .where(
          and(
            eq(merchantPurchases.characterId, hero.id),
            sql`${merchantPurchases.offerId} like ${`${merchantDay(now)}%`}`,
          ),
        ),
    ]);
  const today = contractDay(now);
  const deletedAt = hero.deletedAt;
  const restoreUntil = deletedAt ? new Date(deletedAt.getTime() + RESTORE_WINDOW_MS) : null;
  return {
    id: hero.id,
    name: hero.name,
    classId: hero.classId,
    level: hero.level,
    experience: hero.experience,
    gold: hero.gold,
    progress: hero.progress,
    warehouseLevel: hero.warehouseLevel,
    createdAt: hero.createdAt.toISOString(),
    deleted:
      deletedAt && restoreUntil
        ? {
            at: deletedAt.toISOString(),
            restoreUntil: restoreUntil.toISOString(),
            reason: hero.deleteReason ?? '',
            restorable: authNow.getTime() < restoreUntil.getTime(),
          }
        : null,
    activity: activity
      ? {
          areaId: activity.areaId,
          settledAt: activity.settledAt.toISOString(),
          lastSeenAt: activity.lastSeenAt.toISOString(),
        }
      : null,
    materials: bundle(mats),
    professions: profs,
    items: items.map((i) => adminItemView(i, switches, authNow)),
    quests: quests.map((q) => ({
      id: q.id,
      kind: q.kind,
      questId: q.questId,
      status: q.status,
      contractDay: q.contractDay,
      progress: q.progress,
      objectives: q.objectives,
    })),
    defence: defence ?? null,
    holds: holds.map((h) => ({
      gold: h.gold,
      materials: (h.materials ?? {}) as Record<string, number>,
      items: h.itemIds.length,
      heldUntil: h.heldUntil.toISOString(),
    })),
    daily: {
      ratedDuels: duelRow?.n ?? 0,
      contracts: quests.filter((q) => q.kind === 'contract' && q.contractDay === today).length,
      contractsPerDay: CONTRACTS_PER_DAY,
      merchantBought: bought?.n ?? 0,
    },
  };
}

/** The whole account file. `loginLockedForMs` comes from the in-memory throttle (the route). */
export async function accountFile(
  db: Executor,
  account: Account,
  options: {
    switches: Readonly<TradingSwitches>;
    now: Date;
    authNow: Date;
    adminId: string;
    loginLockedForMs: number;
  },
): Promise<AccountFile> {
  const { switches, now, authNow } = options;
  const heroes = await db
    .select()
    .from(characters)
    .where(eq(characters.accountId, account.id))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  const [shelfItems, shelfMats, [sessionCount], sanctionRows, offerRows, auditRows] =
    await Promise.all([
      db
        .select()
        .from(itemInstances)
        .where(and(eq(itemInstances.shelfAccountId, account.id), eq(itemInstances.onShelf, true)))
        .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id)),
      db
        .select({
          materialId: accountShelfMaterials.materialId,
          quantity: accountShelfMaterials.quantity,
        })
        .from(accountShelfMaterials)
        .where(eq(accountShelfMaterials.accountId, account.id)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sessions)
        .where(
          and(
            eq(sessions.accountId, account.id),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, authNow),
          ),
        ),
      db
        .select()
        .from(sanctions)
        .where(eq(sanctions.subjectId, account.id))
        .orderBy(desc(sanctions.createdAt))
        .limit(20),
      db
        .select()
        .from(tradeOffers)
        .where(
          and(
            eq(tradeOffers.status, 'open'),
            or(
              eq(tradeOffers.senderAccountId, account.id),
              eq(tradeOffers.receiverAccountId, account.id),
            ),
          ),
        )
        .orderBy(desc(tradeOffers.createdAt)),
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accountId, account.id))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(AUDIT_LIMIT),
    ]);
  const counterpartIds = [
    ...new Set(
      offerRows.map((o) =>
        o.senderAccountId === account.id ? o.receiverAccountId : o.senderAccountId,
      ),
    ),
  ];
  const counterparts = counterpartIds.length
    ? await db
        .select({ id: accounts.id, handle: accounts.handle, displayName: accounts.displayName })
        .from(accounts)
        .where(inArray(accounts.id, counterpartIds))
    : [];
  const heroName = new Map(heroes.map((h) => [h.id, h.name]));
  const files: HeroFile[] = [];
  for (const h of heroes) files.push(await heroFile(db, h, switches, now, authNow));
  return {
    handle: account.handle,
    displayName: account.displayName,
    role: account.role,
    createdAt: account.createdAt.toISOString(),
    testAccount: account.isTest,
    emailVerified: account.emailVerifiedAt !== null,
    characterSlots: account.characterSlots,
    sessions: sessionCount?.n ?? 0,
    loginLockedForMs: options.loginLockedForMs,
    shelf: {
      gold: account.shelfGold,
      materials: bundle(shelfMats),
      items: shelfItems.map((i) => adminItemView(i, switches, authNow)),
    },
    heroes: files,
    sanctions: sanctionRows.map((s) => ({
      id: s.id,
      kind: s.kind,
      reason: s.reason,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      liftedAt: s.liftedAt?.toISOString() ?? null,
      active: s.liftedAt === null && s.expiresAt.getTime() > authNow.getTime(),
    })),
    offers: offerRows.map((o) => {
      const otherId = o.senderAccountId === account.id ? o.receiverAccountId : o.senderAccountId;
      const other = counterparts.find((c) => c.id === otherId);
      return {
        id: o.id,
        direction: o.senderAccountId === account.id ? 'sent' : 'received',
        counterpart: other ? { handle: other.handle, displayName: other.displayName } : null,
        status: o.status,
        expiresAt: o.expiresAt.toISOString(),
        createdAt: o.createdAt.toISOString(),
      };
    }),
    audit: auditRows.map((r) => ({
      id: r.id,
      event: r.event,
      at: r.createdAt.toISOString(),
      heroName: r.characterId ? (heroName.get(r.characterId) ?? null) : null,
      data: scrubAuditData(r.data),
    })),
    own: account.id === options.adminId,
  };
}
