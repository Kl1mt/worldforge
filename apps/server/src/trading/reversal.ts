import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  SANCTION_FOR_ACTION,
  TRADE_REVERSAL_TEXT,
  actionableRoles,
  holdUntil as holdUntilAt,
  isMaterialId,
  moderationDecision,
  reversalDecision,
  reversedItemState,
  validSanctionDuration,
  type AccountRole,
  type MaterialBundle,
  type MaterialId,
  type ReversalItemFacts,
  type ReversalPurseFacts,
  type ReversalParty,
  type TradeReversalDecision,
  type TradeReversalRefusal,
} from '@worldforge/game-core';
import {
  accounts,
  auditLog,
  characters,
  itemInstances,
  reports,
  tradeHolds,
  tradeOfferLines,
  tradeOffers,
  type Account,
  type Character,
  type ItemInstance,
  type Sanction,
  type TradeHold,
  type TradeOffer,
  type TradeOfferLine,
  type TradeOfferStatus,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { changeGold, materialList, type MaterialStack } from '../economy/shared.js';
import { lockOwnedCharacter, type ItemView } from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { heldValueOf } from '../shelf/held.js';
import { recordTelemetry, type TelemetryCount } from '../telemetry/record.js';
import type { SanctionEvents } from '../social/sanctions.js';
import { sanctionView, type SanctionView } from '../social/sanctions.js';
import { issueSanction } from '../social/moderation.js';
import { assertPlayerText } from '../social/text.js';
import { tradeKey } from '../social/targets.js';

/**
 * Trade moderation (ticket T.6, docs/TRADING.md "Moderator reversal and its limits" and "T.6 as
 * built"): the moderators' trade history and case view, and the reversal of a completed trade.
 *
 * ## Who
 * Staff only (`/api/mod/*`). A viewer sees a trade only if they may act on at least one of its two
 * players (game-core `actionableRoles`: below their own role) and is not one of them; a reversal
 * needs **both** in reach (`moderationDecision(…, 'reverseTrade', …)`), so nobody reverses their
 * own trade and a moderator never reverses one with another moderator or an admin. Views name
 * players by handle and display name only: no account ids, no emails, nothing personal.
 *
 * ## The reversal, all or nothing
 * Game-core `reversalDecision` judges the locked facts: an accepted trade, not yet reversed, within
 * 14 days of its accept; every item still on the hero that received it (pack or worn), unforged,
 * not shelved, stored, offered or traded on; the received gold and materials still on that hero
 * beyond what *other* trades hold there. Any refusal refuses everything (`409
 * trade_not_reversible`, every reason in plain words). Otherwise, in one transaction: the trade's
 * holds end (`released_at`, one `trade.release` row each with `via: 'reverse'`), every item goes
 * back to the hero it came from as it was traded (`reversedItemState`: bind on equip again,
 * `traded_count − 1`, unequipped, unlocked, no hold), the gold and materials go back both ways
 * (`changeGold` / `changeMaterialsTx`, so nothing dips into another trade's hold), the offer gets
 * `reversed_at`, `reversed_by` and the reason both players see, and one `trade.reverse` audit row
 * mirrors the `trade.accept` row (same sides, the other direction). Telemetry `trade.reverse`,
 * `gold.in/out trade_reverse`, `material.in/out trade_reverse` (in = out). The trade cap counters
 * are not given back (a reversed trade still used the week's caps).
 *
 * ## Lock order (T.5's, extended)
 * 1. the moderator's account row `for share` (the role re-read);
 * 2. both players' account rows in id order: `for update` for the player sanctioned in the same
 *    flow (4.1's sanction lock), `for share` otherwise. Every trade write share-locks both of its
 *    players' rows before anything else, so it either commits first or waits here;
 * 3. offer rows `for update`, in id order: the trade, and (only when the sanction is a trade
 *    restriction or a suspension, which void the player's open offers) those open offers too;
 * 4. heroes `for no key update` in id order (settled first): the trade's two, and the senders of
 *    the offers the sanction will void;
 * 5. the trade's item rows `for update` in `(created_at, id)` order, then its hold rows (id order);
 * 6. the sanction (its listeners re-lock only rows already held), telemetry at commit.
 * So a reversal and a hold's release, a spend, a shelf move, a Forge action, another reversal or
 * the accept of a new offer of the same heroes never wait on each other in a cycle.
 */

export interface TradePartyView {
  handle: string;
  displayName: string;
  role: AccountRole;
  hero: { name: string; classId: string; level: number } | null;
}

export interface ModTradeSide {
  items: ItemView[];
  gold: number;
  materials: MaterialStack[];
}

export interface ModTradeSummary {
  id: string;
  status: TradeOfferStatus;
  kind: 'gift' | 'swap';
  sender: Omit<TradePartyView, 'hero'>;
  receiver: Omit<TradePartyView, 'hero'>;
  createdAt: string;
  closedAt: string | null;
  reversedAt: string | null;
  /** Counts only (the list); the case view has every line. */
  give: { items: number; gold: number; materialUnits: number; rarities: string[] };
  ask: { items: number; gold: number; materialUnits: number; rarities: string[] };
}

export interface ReversalRefusalView extends TradeReversalRefusal {
  text: string;
}

export interface ReturnMove {
  items: { id: string; worn: boolean; locked: boolean }[];
  gold: number;
  materials: MaterialStack[];
}

export interface TrailEntry {
  event: string;
  at: string;
  /** The player or moderator who acted, when it was a person. */
  by: { handle: string; displayName: string } | null;
  text: string;
}

export interface ModTradeCase extends Omit<ModTradeSummary, 'give' | 'ask'> {
  relation: string;
  expiresAt: string;
  senderHero: TradePartyView['hero'];
  receiverHero: TradePartyView['hero'];
  give: ModTradeSide;
  ask: ModTradeSide;
  voidReason: string | null;
  heldUntil: string | null;
  reversal: {
    at: string;
    reason: string;
    by: { handle: string; displayName: string } | null;
  } | null;
  /** Whether it can be reversed now, and every reason it can't. */
  reversible: {
    possible: boolean;
    deadline: string | null;
    refusals: ReversalRefusalView[];
    /** Whether the viewer may reverse it (both players below their role). */
    canAct: boolean;
    cannotAct: string | null;
  };
  /** What a reversal would move back: to the sender (from the receiver) and to the receiver. */
  moves: { toSender: ReturnMove; toReceiver: ReturnMove };
  holds: {
    party: ReversalParty;
    heldUntil: string;
    releasedAt: string | null;
    gold: number;
    materials: MaterialStack[];
    items: number;
  }[];
  trail: TrailEntry[];
  /** Open reports about this trade (`#/moderation?case=<id>` opens the first). */
  reports: { open: number; reportId: string | null };
}

interface Sides {
  give: { itemIds: string[]; gold: number; materials: MaterialBundle; snapshots: ItemView[] };
  ask: { itemIds: string[]; gold: number; materials: MaterialBundle; snapshots: ItemView[] };
}

function sidesOf(lines: readonly TradeOfferLine[]): Sides {
  const empty = () => ({
    itemIds: [] as string[],
    gold: 0,
    materials: {} as MaterialBundle,
    snapshots: [] as ItemView[],
  });
  const out: Sides = { give: empty(), ask: empty() };
  for (const l of lines) {
    const side = out[l.side];
    if (l.kind === 'item') {
      side.itemIds.push(l.itemId!);
      side.snapshots.push(l.snapshot as unknown as ItemView);
    } else if (l.kind === 'gold') side.gold += l.amount;
    else if (isMaterialId(l.materialId ?? '')) {
      const id = l.materialId as MaterialId;
      side.materials[id] = (side.materials[id] ?? 0) + l.amount;
    }
  }
  return out;
}

const hasAny = (s: Sides['give']) =>
  s.gold > 0 || s.itemIds.length > 0 || Object.keys(s.materials).length > 0;

const units = (m: MaterialBundle) => Object.values(m).reduce((n, q) => n + (q ?? 0), 0);

async function linesOf(db: Executor, offerIds: string[]): Promise<TradeOfferLine[]> {
  if (offerIds.length === 0) return [];
  return db
    .select()
    .from(tradeOfferLines)
    .where(inArray(tradeOfferLines.offerId, offerIds))
    .orderBy(asc(tradeOfferLines.id));
}

const notFound = () => new ApiError(404, 'not_found', 'No such trade.');

/** The moderator, re-read under a share lock (a role revoked by the CLI stops the next action). */
async function lockStaff(tx: Executor, actorId: string): Promise<Account> {
  const [actor] = await tx.select().from(accounts).where(eq(accounts.id, actorId)).for('share');
  if (!actor || moderationDecision(actor.role, 'viewQueue') !== 'allowed') {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  return actor;
}

/** Whether a viewer may see a trade between these two accounts at all. */
function maySee(viewer: { id: string; role: AccountRole }, a: Account, b: Account): boolean {
  if (a.id === viewer.id || b.id === viewer.id) return false;
  const roles = actionableRoles(viewer.role);
  return roles.includes(a.role) || roles.includes(b.role);
}

/** Why the viewer may not reverse it (null: they may). */
function cannotReverse(
  viewer: { id: string; role: AccountRole },
  parties: readonly Account[],
): string | null {
  for (const p of parties) {
    const d = moderationDecision(viewer.role, 'reverseTrade', {
      self: p.id === viewer.id,
      role: p.role,
    });
    if (d === 'not_found') return 'Only moderators and admins can reverse trades.';
    if (d === 'forbidden') {
      return p.id === viewer.id
        ? 'Nobody reverses their own trade.'
        : 'One of these players has your role or a higher one: only a higher role can reverse this trade.';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The plan: what would move back, and whether it can
// ---------------------------------------------------------------------------------------------

interface AcceptRecord {
  /** Per item id: `traded_count` before the trade and the hero it went to. */
  items: Map<string, { tradedCount: number; toCharacterId: string }>;
}

/** The trade's `trade.accept` row: the items as they were traded and where each went. */
async function acceptRecord(db: Executor, offerId: string): Promise<AcceptRecord> {
  const [row] = await db
    .select({ data: auditLog.data })
    .from(auditLog)
    .where(
      and(
        sql`${auditLog.event} like 'trade.%'`,
        sql`(${auditLog.data}->>'offerId') = ${offerId}`,
        eq(auditLog.event, 'trade.accept'),
      ),
    )
    .limit(1);
  const items = new Map<string, { tradedCount: number; toCharacterId: string }>();
  const d = (row?.data ?? {}) as {
    give?: { items?: unknown[] };
    ask?: { items?: unknown[] };
  };
  for (const side of [d.give, d.ask]) {
    for (const raw of side?.items ?? []) {
      const it = raw as { id?: string; tradedCount?: number; to?: { characterId?: string } };
      if (typeof it.id === 'string' && typeof it.to?.characterId === 'string') {
        items.set(it.id, {
          tradedCount: typeof it.tradedCount === 'number' ? it.tradedCount : 0,
          toCharacterId: it.to.characterId,
        });
      }
    }
  }
  return { items };
}

interface Plan {
  decision: TradeReversalDecision;
  sides: Sides;
  /** Item rows now (missing ones are gone), with who received each. */
  items: { id: string; receivedBy: ReversalParty; row: ItemInstance | null }[];
  holds: TradeHold[];
}

/**
 * Judges the reversal from the rows as `db` sees them (locked in the reversal; a snapshot in the
 * case view). `heroes` are the trade's two heroes as read (settled, in the reversal).
 */
async function planReversal(
  db: Executor,
  offer: TradeOffer,
  heroes: { sender: Character | null; receiver: Character | null },
  now: Date,
  lockRows: boolean,
): Promise<Plan> {
  const sides = sidesOf(await linesOf(db, [offer.id]));
  const record = await acceptRecord(db, offer.id);
  const ids = [...sides.give.itemIds, ...sides.ask.itemIds];
  const q = db
    .select()
    .from(itemInstances)
    .where(inArray(itemInstances.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
  const rows = ids.length ? await (lockRows ? q.for('update') : q) : [];
  const hq = db
    .select()
    .from(tradeHolds)
    .where(eq(tradeHolds.offerId, offer.id))
    .orderBy(asc(tradeHolds.id));
  const holds = await (lockRows ? hq.for('update') : hq);

  const items: Plan['items'] = [];
  const facts: ReversalItemFacts[] = [];
  for (const [side, receivedBy] of [
    ['give', 'receiver'],
    ['ask', 'sender'],
  ] as const) {
    for (const id of sides[side].itemIds) {
      const row = rows.find((r) => r.id === id) ?? null;
      const rec = record.items.get(id);
      const to =
        rec?.toCharacterId ??
        (receivedBy === 'receiver' ? offer.receiverCharacterId : offer.senderCharacterId) ??
        '';
      items.push({ id, receivedBy, row });
      facts.push({
        id,
        receivedBy,
        receivedByCharacterId: to,
        tradedCountAfter: (rec?.tradedCount ?? 0) + 1,
        now: row
          ? {
              characterId: row.characterId,
              inWarehouse: row.inWarehouse,
              onShelf: row.onShelf,
              escrowOfferId: row.escrowOfferId ?? null,
              tradedCount: row.tradedCount,
              upgradeLevel: row.upgradeLevel,
              upgradePity: row.upgradePity,
              rerollCount: row.rerollCount,
              forgeCounter: row.forgeCounter,
              affixes: row.affixes,
            }
          : null,
      });
    }
  }

  // What each receiving hero can give back: its purse and stacks, less what *other* trades hold.
  const purses: ReversalPurseFacts[] = [];
  for (const [party, side, hero] of [
    ['receiver', sides.give, heroes.receiver],
    ['sender', sides.ask, heroes.sender],
  ] as const) {
    if (side.gold === 0 && Object.keys(side.materials).length === 0) continue;
    const own = holds.filter(
      (h) =>
        hero &&
        h.characterId === hero.id &&
        h.releasedAt === null &&
        h.heldUntil.getTime() > now.getTime(),
    );
    const held = hero ? await heldValueOf(db, hero.id, now) : { gold: 0, materials: {} };
    const ownGold = own.reduce((n, h) => n + h.gold, 0);
    const stock = hero ? await loadMaterialBundle(db, hero.id) : {};
    const materials: ReversalPurseFacts['materials'] = {};
    for (const [id, q] of Object.entries(side.materials) as [MaterialId, number][]) {
      const ownQ = own.reduce((n, h) => n + (h.materials[id] ?? 0), 0);
      materials[id] = {
        received: q,
        available: (stock[id] ?? 0) - ((held.materials[id] ?? 0) - ownQ),
      };
    }
    purses.push({
      party,
      gold: {
        received: side.gold,
        available: hero ? hero.gold - (held.gold - ownGold) : 0,
      },
      materials,
    });
  }
  const decision = reversalDecision({
    status: offer.status,
    closedAt: offer.closedAt,
    reversedAt: offer.reversedAt,
    now,
    items: facts,
    purses,
  });
  return { decision, sides, items, holds };
}

const refusalViews = (d: TradeReversalDecision): ReversalRefusalView[] =>
  d.refusals.map((r) => ({ ...r, text: TRADE_REVERSAL_TEXT[r.check] }));

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

type People = Map<string, Account>;

async function peopleOf(db: Executor, ids: (string | null)[]): Promise<People> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(accounts).where(inArray(accounts.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

const who = (a: Account | undefined): Omit<TradePartyView, 'hero'> => ({
  handle: a?.handle ?? '',
  displayName: a?.displayName ?? '',
  role: a?.role ?? 'player',
});

const person = (a: Account | undefined) =>
  a ? { handle: a.handle, displayName: a.displayName } : null;

function summaryOf(o: TradeOffer, lines: TradeOfferLine[], people: People): ModTradeSummary {
  const sides = sidesOf(lines);
  const count = (s: Sides['give']) => ({
    items: s.itemIds.length,
    gold: s.gold,
    materialUnits: units(s.materials),
    rarities: s.snapshots.map((v) => v.rarityId),
  });
  return {
    id: o.id,
    status: o.status,
    kind: hasAny(sides.ask) ? 'swap' : 'gift',
    sender: who(people.get(o.senderAccountId)),
    receiver: who(people.get(o.receiverAccountId)),
    createdAt: o.createdAt.toISOString(),
    closedAt: o.closedAt?.toISOString() ?? null,
    reversedAt: o.reversedAt?.toISOString() ?? null,
    give: count(sides.give),
    ask: count(sides.ask),
  };
}

export type TradeListStatus = 'all' | 'open' | 'accepted' | 'reversed' | 'ended';

export interface TradeListQuery {
  handle?: string | undefined;
  with?: string | undefined;
  status?: TradeListStatus | undefined;
  before?: string | undefined;
  limit: number;
}

/**
 * The trade history for staff, newest first: every offer (or one account's, or one pair's) the
 * viewer may see. `before` is the id of the last one shown (ids are time-ordered).
 */
export async function listTrades(
  db: Executor,
  viewer: { id: string; role: AccountRole },
  q: TradeListQuery,
): Promise<{ trades: ModTradeSummary[]; nextCursor: string | null }> {
  const byHandle = async (h: string | undefined) => {
    if (!h) return null;
    const [a] = await db.select().from(accounts).where(eq(accounts.handle, h.toLowerCase()));
    return a ?? 'missing';
  };
  const a = await byHandle(q.handle);
  const b = await byHandle(q.with);
  if (a === 'missing' || b === 'missing') return { trades: [], nextCursor: null };
  const roles = actionableRoles(viewer.role);
  if (roles.length === 0) return { trades: [], nextCursor: null };
  const s = alias(accounts, 's');
  const r = alias(accounts, 'r');
  const party = (acc: Account) =>
    or(eq(tradeOffers.senderAccountId, acc.id), eq(tradeOffers.receiverAccountId, acc.id));
  const status =
    q.status === 'open'
      ? eq(tradeOffers.status, 'open')
      : q.status === 'accepted'
        ? and(eq(tradeOffers.status, 'accepted'), isNull(tradeOffers.reversedAt))
        : q.status === 'reversed'
          ? sql`${tradeOffers.reversedAt} is not null`
          : q.status === 'ended'
            ? inArray(tradeOffers.status, ['cancelled', 'declined', 'expired', 'void'])
            : undefined;
  const rows = await db
    .select({ offer: tradeOffers })
    .from(tradeOffers)
    .innerJoin(s, eq(s.id, tradeOffers.senderAccountId))
    .innerJoin(r, eq(r.id, tradeOffers.receiverAccountId))
    .where(
      and(
        a ? party(a) : undefined,
        b ? party(b) : undefined,
        status,
        q.before ? lt(tradeOffers.id, q.before) : undefined,
        sql`${tradeOffers.senderAccountId} <> ${viewer.id}`,
        sql`${tradeOffers.receiverAccountId} <> ${viewer.id}`,
        or(inArray(s.role, roles), inArray(r.role, roles)),
      ),
    )
    .orderBy(desc(tradeOffers.id))
    .limit(q.limit + 1);
  const offers = rows.slice(0, q.limit).map((x) => x.offer);
  const lines = await linesOf(
    db,
    offers.map((o) => o.id),
  );
  const people = await peopleOf(
    db,
    offers.flatMap((o) => [o.senderAccountId, o.receiverAccountId]),
  );
  return {
    trades: offers.map((o) =>
      summaryOf(
        o,
        lines.filter((l) => l.offerId === o.id),
        people,
      ),
    ),
    nextCursor: rows.length > q.limit ? (offers[offers.length - 1]?.id ?? null) : null,
  };
}

const TRAIL_TEXT: Record<string, string> = {
  'trade.offer': 'Offer sent; the sender’s side went into escrow.',
  'trade.cancel': 'Cancelled by the sender; the escrow went back.',
  'trade.decline': 'Declined by the receiver; the escrow went back.',
  'trade.expire': 'Expired after 48 hours; the escrow went back.',
  'trade.void': 'Withdrawn',
  'trade.accept': 'Accepted: both sides changed hands and are held for 72 hours.',
  'trade.release': 'A hold ended.',
  'trade.reverse': 'Reversed by a moderator: everything went back.',
};

async function trailOf(db: Executor, offer: TradeOffer): Promise<TrailEntry[]> {
  const rows = await db
    .select({ event: auditLog.event, data: auditLog.data, at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(sql`${auditLog.event} like 'trade.%'`, sql`(${auditLog.data}->>'offerId') = ${offer.id}`),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
  const actorOf = (r: (typeof rows)[number]): string | null => {
    const d = r.data as { by?: unknown };
    if (typeof d.by === 'string') return d.by;
    if (r.event === 'trade.offer') return offer.senderAccountId;
    if (r.event === 'trade.accept') return offer.receiverAccountId;
    return null;
  };
  const people = await peopleOf(db, rows.map(actorOf));
  return rows.map((r) => {
    const d = r.data as { reason?: unknown; via?: unknown; switches?: unknown };
    let text = TRAIL_TEXT[r.event] ?? r.event;
    if (r.event === 'trade.void') {
      text = `Withdrawn (${typeof d.reason === 'string' ? d.reason : 'void'}); the escrow went back.`;
    } else if (r.event === 'trade.release' && d.via === 'reverse') {
      text = 'A hold ended early: the trade was reversed.';
    } else if (r.event === 'trade.reverse' && typeof d.reason === 'string') {
      text = `Reversed by a moderator: everything went back. Reason: ${d.reason}`;
    }
    return {
      event: r.event,
      at: r.at.toISOString(),
      by: person(people.get(actorOf(r) ?? '')),
      text,
    };
  });
}

async function heroOf(db: Executor, id: string | null): Promise<Character | null> {
  if (!id) return null;
  const [h] = await db.select().from(characters).where(eq(characters.id, id));
  return h ?? null;
}

const heroView = (h: Character | null) =>
  h ? { name: h.name, classId: h.classId, level: h.level } : null;

function returnMoves(plan: Plan): ModTradeCase['moves'] {
  const move = (party: ReversalParty, side: Sides['give']): ReturnMove => ({
    items: plan.items
      .filter((i) => i.receivedBy === party)
      .map((i) => ({
        id: i.id,
        worn: i.row?.equippedSlot != null,
        locked: i.row?.locked ?? false,
      })),
    gold: side.gold,
    materials: materialList(side.materials),
  });
  // What the receiver got goes back to the sender, and the other way round.
  return {
    toSender: move('receiver', plan.sides.give),
    toReceiver: move('sender', plan.sides.ask),
  };
}

/**
 * The case view of one trade for staff: every line, both players and heroes, holds, the audit
 * trail, open reports, and whether it can be reversed (a dry run of the reversal's own rules).
 * `404` for a trade the viewer may not see (their own, or one with nobody in their reach).
 */
export async function tradeCase(
  db: Executor,
  viewer: { id: string; role: AccountRole },
  offerId: string,
  now: Date,
): Promise<ModTradeCase> {
  const [offer] = await db.select().from(tradeOffers).where(eq(tradeOffers.id, offerId));
  if (!offer) throw notFound();
  const people = await peopleOf(db, [
    offer.senderAccountId,
    offer.receiverAccountId,
    offer.reversedBy,
  ]);
  const sender = people.get(offer.senderAccountId)!;
  const receiver = people.get(offer.receiverAccountId)!;
  if (!maySee(viewer, sender, receiver)) throw notFound();
  const heroes = {
    sender: await heroOf(db, offer.senderCharacterId),
    receiver: await heroOf(db, offer.receiverCharacterId),
  };
  const plan = await planReversal(db, offer, heroes, now, false);
  const lines = await linesOf(db, [offer.id]);
  const summary = summaryOf(offer, lines, people);
  const side = (s: Sides['give']): ModTradeSide => ({
    items: s.snapshots,
    gold: s.gold,
    materials: materialList(s.materials),
  });
  const [open] = await db
    .select({ n: sql<number>`count(*)::int`, first: sql<string | null>`min(${reports.id}::text)` })
    .from(reports)
    .where(and(eq(reports.targetKey, tradeKey(offer.id)), eq(reports.status, 'open')));
  const cannot = cannotReverse(viewer, [sender, receiver]);
  return {
    ...summary,
    relation: offer.relation,
    expiresAt: offer.expiresAt.toISOString(),
    senderHero: heroView(heroes.sender),
    receiverHero: heroView(heroes.receiver),
    give: side(plan.sides.give),
    ask: side(plan.sides.ask),
    voidReason: offer.voidReason ?? null,
    heldUntil:
      offer.status === 'accepted' && offer.closedAt
        ? holdUntilAt(offer.closedAt).toISOString()
        : null,
    reversal: offer.reversedAt
      ? {
          at: offer.reversedAt.toISOString(),
          reason: offer.reverseReason ?? '',
          by: person(people.get(offer.reversedBy ?? '')),
        }
      : null,
    reversible: {
      possible: plan.decision.reversible,
      deadline: plan.decision.deadline,
      refusals: refusalViews(plan.decision),
      canAct: cannot === null,
      cannotAct: cannot,
    },
    moves: returnMoves(plan),
    holds: plan.holds.map((h) => ({
      party: h.characterId === offer.senderCharacterId ? 'sender' : 'receiver',
      heldUntil: h.heldUntil.toISOString(),
      releasedAt: h.releasedAt?.toISOString() ?? null,
      gold: h.gold,
      materials: materialList(h.materials),
      items: h.itemIds.length,
    })),
    trail: await trailOf(db, offer),
    reports: { open: Number(open?.n ?? 0), reportId: open?.first ?? null },
  };
}

// ---------------------------------------------------------------------------------------------
// The reversal
// ---------------------------------------------------------------------------------------------

export type ReversalSanctionAction = 'mute' | 'suspend' | 'restrictTrade';

export interface ReverseInput {
  actorId: string;
  offerId: string;
  reason: string;
  /** Optional: a sanction on one of the two players, in the same transaction. */
  sanction?: { handle: string; action: ReversalSanctionAction; durationHours: number } | undefined;
  now: Date;
}

export interface ReverseResult {
  offerId: string;
  reversedAt: string;
  sanction: SanctionView | null;
}

/** Sanctions that void the subject's open offers through T.4's seam (T.5's listener). */
const VOIDS_OFFERS: ReadonlySet<ReversalSanctionAction> = new Set(['suspend', 'restrictTrade']);

/**
 * Reverses a completed trade, all or nothing, in `tx` (see the module comment for the rules and
 * the lock order). Throws `409 trade_not_reversible` with every reason when it can't.
 */
export async function reverseTrade(
  tx: Transaction,
  input: ReverseInput,
  activity: ActivityOptions,
  events: SanctionEvents,
): Promise<ReverseResult> {
  const { now } = input;
  const reason = assertPlayerText('sanctionReason', input.reason, 'reason');
  // 1. The moderator.
  const actor = await lockStaff(tx, input.actorId);
  const [peek] = await tx
    .select({
      sender: tradeOffers.senderAccountId,
      receiver: tradeOffers.receiverAccountId,
    })
    .from(tradeOffers)
    .where(eq(tradeOffers.id, input.offerId));
  if (!peek) throw notFound();
  // 2. Both players, in id order; the one sanctioned in this flow for update.
  const ids = [peek.sender, peek.receiver];
  const [unlockedA, unlockedB] = await Promise.all(
    ids.map(async (id) => (await tx.select().from(accounts).where(eq(accounts.id, id)))[0]),
  );
  if (!unlockedA || !unlockedB) throw notFound();
  // A party to the trade is told plainly (they know their own trades); a trade with nobody in
  // the viewer's reach doesn't exist for them.
  const ownTrade = unlockedA.id === actor.id || unlockedB.id === actor.id;
  if (ownTrade) throw new ApiError(403, 'forbidden', 'Nobody reverses their own trade.');
  if (!maySee(actor, unlockedA, unlockedB)) throw notFound();
  let subjectId: string | null = null;
  if (input.sanction) {
    const handle = input.sanction.handle.toLowerCase();
    const s = [unlockedA, unlockedB].find((a) => a.handle === handle);
    if (!s) {
      throw new ApiError(
        422,
        'not_a_party',
        'A sanction in a reversal can only go to one of the two players in the trade.',
      );
    }
    subjectId = s.id;
  }
  const parties = new Map<string, Account>();
  for (const id of [...ids].sort()) {
    const q = tx.select().from(accounts).where(eq(accounts.id, id));
    const [row] = await (id === subjectId ? q.for('update') : q.for('share'));
    if (!row) throw notFound();
    parties.set(id, row);
  }
  const sender = parties.get(peek.sender)!;
  const receiver = parties.get(peek.receiver)!;
  const cannot = cannotReverse(actor, [sender, receiver]);
  if (cannot) throw new ApiError(403, 'forbidden', cannot);
  const subject = subjectId ? parties.get(subjectId)! : null;
  if (input.sanction && subject) {
    const d = moderationDecision(actor.role, input.sanction.action, {
      self: subject.id === actor.id,
      role: subject.role,
    });
    if (d !== 'allowed')
      throw new ApiError(403, 'forbidden', 'Only a higher role can act on this account.');
    if (
      !validSanctionDuration(
        SANCTION_FOR_ACTION[input.sanction.action],
        input.sanction.durationHours,
      )
    ) {
      throw new ApiError(
        400,
        'validation_failed',
        'That duration is not allowed for this sanction.',
        {
          fields: { 'sanction.durationHours': 'That duration is not allowed for this sanction.' },
        },
      );
    }
  }
  // 3. Offer rows: the trade, and the open offers the sanction will void.
  const voiding: TradeOffer[] =
    subject && input.sanction && VOIDS_OFFERS.has(input.sanction.action)
      ? await tx
          .select()
          .from(tradeOffers)
          .where(
            and(
              eq(tradeOffers.status, 'open'),
              or(
                eq(tradeOffers.senderAccountId, subject.id),
                eq(tradeOffers.receiverAccountId, subject.id),
              ),
            ),
          )
      : [];
  const offerIds = [...new Set([input.offerId, ...voiding.map((o) => o.id)])].sort();
  const lockedOffers = await tx
    .select()
    .from(tradeOffers)
    .where(inArray(tradeOffers.id, offerIds))
    .orderBy(asc(tradeOffers.id))
    .for('update');
  const offer = lockedOffers.find((o) => o.id === input.offerId);
  if (!offer) throw notFound();
  // The trade itself first: nothing else is worth locking for an offer that can't be reversed.
  const early = reversalDecision({
    status: offer.status,
    closedAt: offer.closedAt,
    reversedAt: offer.reversedAt,
    now,
    items: [],
    purses: [],
  });
  if (!early.reversible) throw notReversible(early);
  // 4. Heroes in id order (settled first): the trade's two, and the voided offers' senders.
  const heroAccounts = new Map<string, string>([
    [offer.senderCharacterId, offer.senderAccountId],
    [offer.receiverCharacterId!, offer.receiverAccountId],
  ]);
  for (const o of lockedOffers) {
    if (o.id !== offer.id && o.status === 'open')
      heroAccounts.set(o.senderCharacterId, o.senderAccountId);
  }
  const heroes = new Map<string, Character>();
  for (const heroId of [...heroAccounts.keys()].sort()) {
    heroes.set(heroId, await lockOwnedCharacter(tx, heroAccounts.get(heroId)!, heroId, activity));
  }
  let senderHero = heroes.get(offer.senderCharacterId)!;
  let receiverHero = heroes.get(offer.receiverCharacterId!)!;
  // 5. Items and holds, then the verdict from the locked facts.
  const plan = await planReversal(
    tx,
    offer,
    { sender: senderHero, receiver: receiverHero },
    now,
    true,
  );
  if (!plan.decision.reversible) throw notReversible(plan.decision);

  // The trade's holds end now (each once, like the sweep's release).
  const ended = await tx
    .update(tradeHolds)
    .set({ releasedAt: now })
    .where(and(eq(tradeHolds.offerId, offer.id), isNull(tradeHolds.releasedAt)))
    .returning();
  for (const h of ended) {
    await writeAudit(tx, {
      event: 'trade.release',
      accountId: h.accountId,
      characterId: h.characterId,
      data: {
        holdId: h.id,
        offerId: h.offerId,
        gold: h.gold,
        materials: h.materials,
        items: h.itemIds,
        heldUntil: h.heldUntil.toISOString(),
        via: 'reverse',
      },
    });
  }

  // Items go back to the hero they came from, as they were traded.
  const acceptedAt = offer.closedAt!;
  const itemAudit: Record<ReversalParty, Record<string, unknown>[]> = { sender: [], receiver: [] };
  for (const it of plan.items) {
    const row = it.row!;
    const from = it.receivedBy === 'receiver' ? receiverHero : senderHero;
    const to = it.receivedBy === 'receiver' ? senderHero : receiverHero;
    const state = reversedItemState(
      { tradedCount: row.tradedCount, firstEquippedAt: row.firstEquippedAt ?? null },
      acceptedAt,
    );
    const moved = await tx
      .update(itemInstances)
      .set({ characterId: to.id, ...state })
      .where(
        and(
          eq(itemInstances.id, row.id),
          eq(itemInstances.characterId, from.id),
          isNull(itemInstances.escrowOfferId),
          eq(itemInstances.inWarehouse, false),
          eq(itemInstances.onShelf, false),
        ),
      )
      .returning({ id: itemInstances.id });
    if (moved.length !== 1) throw new ApiError(409, 'conflict', 'The trade changed; try again.');
    itemAudit[it.receivedBy].push({
      id: row.id,
      baseId: row.baseId,
      rarityId: row.rarityId,
      variant: row.variant ?? null,
      setId: row.setId ?? null,
      mythicId: row.mythicId ?? null,
      itemLevel: row.itemLevel,
      wasWorn: row.equippedSlot ?? null,
      wasLocked: row.locked,
      tradedCount: state.tradedCount,
      from: { accountId: from.accountId, characterId: from.id },
      to: { accountId: to.accountId, characterId: to.id },
    });
  }
  // Gold and materials: both heroes give back first (no dip into another trade's hold), then both
  // get theirs.
  const { give, ask } = plan.sides;
  if (give.gold > 0) receiverHero = await changeGold(tx, receiverHero, -give.gold, now);
  if (Object.keys(give.materials).length > 0) {
    await changeMaterialsTx(tx, receiverHero.id, negate(give.materials), now);
  }
  if (ask.gold > 0) senderHero = await changeGold(tx, senderHero, -ask.gold, now);
  if (Object.keys(ask.materials).length > 0) {
    await changeMaterialsTx(tx, senderHero.id, negate(ask.materials), now);
  }
  if (give.gold > 0) senderHero = await changeGold(tx, senderHero, give.gold, now);
  if (Object.keys(give.materials).length > 0) {
    await changeMaterialsTx(tx, senderHero.id, give.materials, now);
  }
  if (ask.gold > 0) receiverHero = await changeGold(tx, receiverHero, ask.gold, now);
  if (Object.keys(ask.materials).length > 0) {
    await changeMaterialsTx(tx, receiverHero.id, ask.materials, now);
  }
  const done = await tx
    .update(tradeOffers)
    .set({ reversedAt: now, reversedBy: actor.id, reverseReason: reason })
    .where(
      and(
        eq(tradeOffers.id, offer.id),
        eq(tradeOffers.status, 'accepted'),
        isNull(tradeOffers.reversedAt),
      ),
    )
    .returning({ id: tradeOffers.id });
  if (done.length !== 1)
    throw new ApiError(409, 'already_reversed', TRADE_REVERSAL_TEXT.already_reversed);

  // 6. The sanction, if any (its listeners void the subject's open offers, locked above).
  let sanction: Sanction | null = null;
  if (input.sanction && subject) {
    sanction = await issueSanction(tx, {
      actor,
      subject,
      action: input.sanction.action,
      reason,
      durationHours: input.sanction.durationHours,
      targetKey: null,
      target: null,
      now,
      events,
    });
  }

  const kind = hasAny(ask) ? 'swap' : 'gift';
  const senderMaterials = await loadMaterialBundle(tx, senderHero.id);
  const receiverMaterials = await loadMaterialBundle(tx, receiverHero.id);
  const touched = { ...give.materials, ...ask.materials };
  await writeAudit(tx, {
    event: 'trade.reverse',
    accountId: receiver.id,
    characterId: receiverHero.id,
    data: {
      offerId: offer.id,
      kind,
      by: actor.id,
      reason,
      acceptedAt: acceptedAt.toISOString(),
      senderAccountId: sender.id,
      senderCharacterId: senderHero.id,
      receiverAccountId: receiver.id,
      receiverCharacterId: receiverHero.id,
      // The trade's own sides (as in `trade.accept`), now moving the other way.
      give: { items: itemAudit.receiver, gold: give.gold, materials: give.materials },
      ask: { items: itemAudit.sender, gold: ask.gold, materials: ask.materials },
      holdsEnded: ended.map((h) => h.id),
      sender: { goldAfter: senderHero.gold, materialsAfter: pickOf(senderMaterials, touched) },
      receiver: {
        goldAfter: receiverHero.gold,
        materialsAfter: pickOf(receiverMaterials, touched),
      },
      ...(sanction
        ? { sanction: { id: sanction.id, kind: sanction.kind, subject: sanction.subjectId } }
        : {}),
    },
  });
  recordTelemetry(tx, now, reversalTelemetry(kind, plan.items.length, plan.sides));
  return {
    offerId: offer.id,
    reversedAt: now.toISOString(),
    sanction: sanction ? sanctionView(sanction) : null,
  };
}

function notReversible(d: TradeReversalDecision): ApiError {
  return new ApiError(
    409,
    'trade_not_reversible',
    d.refusals.length === 1
      ? TRADE_REVERSAL_TEXT[d.refusals[0]!.check]
      : 'This trade can’t be reversed: not everything in it is still there. A reversal moves everything back or nothing.',
    { reasons: refusalViews(d), deadline: d.deadline },
  );
}

const negate = (m: MaterialBundle): MaterialBundle =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, -(v ?? 0)])) as MaterialBundle;

const pickOf = (m: MaterialBundle, keys: MaterialBundle) =>
  Object.fromEntries(Object.keys(keys).map((k) => [k, m[k as MaterialId] ?? 0]));

/** Telemetry of a reversal: a mirrored trade (in = out), no ids or names (docs/TELEMETRY.md). */
function reversalTelemetry(kind: 'gift' | 'swap', items: number, sides: Sides): TelemetryCount[] {
  const out: TelemetryCount[] = [{ metric: 'trade.reverse', dims: [kind], amount: items }];
  const gold = sides.give.gold + sides.ask.gold;
  if (gold > 0) {
    out.push({ metric: 'gold.out', dims: ['trade_reverse', ''], amount: gold });
    out.push({ metric: 'gold.in', dims: ['trade_reverse', ''], amount: gold });
  }
  for (const side of [sides.give, sides.ask]) {
    for (const [id, q] of Object.entries(side.materials) as [MaterialId, number][]) {
      out.push({ metric: 'material.out', dims: ['trade_reverse', id], amount: q });
      out.push({ metric: 'material.in', dims: ['trade_reverse', id], amount: q });
    }
  }
  return out;
}
