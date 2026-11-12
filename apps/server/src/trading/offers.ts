import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  DEFAULT_TRADING_SETTINGS,
  TRADE_CHECK_TEXT,
  TRADE_REVERSED_TEXT,
  cleanSideMaterials,
  holdUntil as holdUntilAt,
  isMaterialId,
  isOfferExpired,
  offerContents,
  offerExpiresAt,
  openOfferRefusal,
  switchesVoiding,
  tradeCapIncrements,
  checkTradeCaps,
  tradeDecision,
  tradeEndText,
  tradeRelationKind,
  tradingSwitchesOf,
  type MaterialBundle,
  type MaterialId,
  type TradeDecision,
  type TradeItemFacts,
  type TradeOfferFacts,
  type TradeRefusal,
  type TradeSideFacts,
  type TradeStanding,
  type TradeVoidCause,
  type TradingSettings,
  type TradingSwitchPath,
} from '@worldforge/game-core';
import {
  accounts,
  characters,
  itemInstances,
  tradeHolds,
  tradeOfferLines,
  tradeOffers,
  type Character,
  type ItemInstance,
  type TradeHold,
  type TradeOffer,
  type TradeOfferLine,
  type TradeOfferStatus,
} from '../db/schema.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { uuidv7 } from '../db/uuid.js';
import { notifyTx } from '../inbox/notify.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { changeGold, materialList, type MaterialStack } from '../economy/shared.js';
import {
  characterNotFound,
  itemView,
  lockOwnedCharacter,
  type ItemView,
} from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { withdrawFromDefence } from '../arena/model.js';
import { heldValueOf } from '../shelf/held.js';
import { recordTelemetry } from '../telemetry/record.js';
import type { TelemetryCount } from '../telemetry/record.js';
import { hiddenTargetKeys } from '../social/sanctions.js';
import { lockSocialAccounts } from '../social/relations.js';
import { profileFieldKey } from '../social/targets.js';
import { commitTradeCounters, readTradeCounters, tradeCapError } from './counters.js';
import { hiddenCounterpart, loadTradeRelation } from './standing.js';

/**
 * Trade offers (ticket T.5, docs/TRADING.md "T.5 as built"): the transactions behind send,
 * cancel, decline, accept, expire and void, the 72-hour hold and its release.
 *
 * ## Where value sits
 * - **Escrow** (an open offer's `give` side): items keep their row and id, with
 *   `item_instances.escrow_offer_id` set (out of the pack and out of reach of everything else);
 *   gold and materials leave the sender's hero and live only in the offer's `give` lines. The
 *   receiver's `ask` side stays with the receiver until the accept, which takes it inside the swap.
 * - **Held** (after an accept): received items carry `hold_until`; received gold and materials sit
 *   in the hero's purse and stacks with a `trade_holds` row that keeps them from being spent,
 *   traded or shelved until `held_until` (`heldValueOf`, enforced in `changeGold` /
 *   `changeMaterialsTx`).
 *
 * ## Lock order (every trade transaction, and every listener that voids)
 * 1. the actor's account row `for share` (`tradeWrite`), the trading settings row `for share`
 *    (send and accept: a switch turned off serialises with them), then the other party's account
 *    row `for share`. A sanction being issued holds its subject's row `for update`, so a trade
 *    write involving that account either commits first or sees the sanction; share locks never
 *    wait on each other, and nothing that takes an account row exclusively waits on the settings;
 * 2. the open-offer counters of both accounts (advisory `trade-offers:<id>`, id order; send only);
 * 3. offer rows `for update`, in id order;
 * 4. heroes `for no key update` (settling their activity first), in id order;
 * 5. their item rows `for update`, in `(created_at, id)` order;
 * 6. the trade cap counters (T.4's advisory `trade-counters:<id>`, id order), **last**, then the
 *    telemetry rows at commit.
 * Nothing that holds a hero ever waits for an offer row, and the shelf takes its account row
 * before its hero (T.3 changed in T.5), so two accounts trading both ways at once, a trade and a
 * shelf move, a void and an accept can't wait on each other in a cycle.
 */

export const TRADE_OFFER_LOCK = (accountId: string) => `trade-offers:${accountId}`;

export interface SideInput {
  itemIds?: string[];
  gold?: number;
  materials?: Partial<Record<MaterialId, number>>;
}

export interface TradeSideView {
  items: ItemView[];
  gold: number;
  materials: MaterialStack[];
}

export interface TradeHeroView {
  name: string;
  classId: string;
  level: number;
}

export interface TradeOfferView {
  id: string;
  status: TradeOfferStatus;
  /** Whether you sent it or received it. */
  role: 'sender' | 'receiver';
  with: { handle: string; displayName: string | null };
  /** Your hero in this offer (null for a receiver who hasn't picked one yet). */
  yourHero: (TradeHeroView & { id: string }) | null;
  theirHero: TradeHeroView | null;
  /** What the sender gives (in escrow while open). */
  give: TradeSideView;
  /** What the sender asks of the receiver. */
  ask: TradeSideView;
  /** Nothing asked in return. */
  gift: boolean;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  /** For an accepted offer: when what changed hands stops being held. */
  heldUntil: string | null;
  /** Plain words for an offer that ended without a trade. */
  endText: string | null;
  /** Ticket T.6: a moderator reversed this trade: when, the reason, and what it means. */
  reversal: { at: string; reason: string; text: string } | null;
}

/** One hero's held value (inbox). */
export interface TradeHoldView {
  characterId: string;
  heroName: string;
  gold: number;
  materials: MaterialStack[];
  items: number;
  heldUntil: string;
}

const conflict = () =>
  new ApiError(409, 'conflict', 'Something in this offer changed meanwhile. Try again.');

/** A refusal from `tradeDecision`, with the items to flag (unprovenanced) kept off the body. */
export class TradeRefusedError extends ApiError {
  constructor(
    readonly refusals: TradeRefusal[],
    readonly flagged: string[],
  ) {
    super(409, 'trade_refused', 'This offer isn’t possible right now.', {
      reasons: reasonsView(refusals),
    });
  }
}

/**
 * Every refusal as the actor may see it, with the other account's collapsed to one line (T.7 F1:
 * several "they can't" lines would count the rules they miss).
 */
export function reasonsView(refusals: readonly TradeRefusal[]) {
  let them = false;
  return refusals.flatMap((r) => {
    if (r.party === 'them') {
      if (them) return [];
      them = true;
    }
    return [reasonView(r)];
  });
}

/** A refusal as the actor may see it (T.4: the other account's reasons collapse to one line). */
export function reasonView(r: TradeRefusal) {
  const out: Record<string, unknown> = {
    check: r.party === 'them' ? 'them_not_eligible' : r.check,
    party: r.party,
    text: r.party === 'them' ? 'They can’t trade right now.' : textOf(r),
  };
  if (r.metAt && r.party !== 'them') out.metAt = r.metAt;
  if (r.side) out.side = r.side;
  if (r.itemId) out.itemId = r.itemId;
  if (r.kind) out.kind = r.kind;
  if (r.materialId) out.materialId = r.materialId;
  return out;
}

const textOf = (r: TradeRefusal) => TRADE_CHECK_TEXT[r.check];

/** The item fields `tradeDecision` reads, from a row. */
export function itemFacts(i: ItemInstance): TradeItemFacts {
  return {
    id: i.id,
    rarityId: i.rarityId,
    variant: i.variant ?? null,
    setId: i.setId ?? null,
    source: i.source,
    binding: i.binding ?? null,
    tradedCount: i.tradedCount,
    firstEquippedAt: i.firstEquippedAt ?? null,
    equippedSlot: i.equippedSlot ?? null,
    upgradeLevel: i.upgradeLevel,
    upgradePity: i.upgradePity,
    rerollCount: i.rerollCount,
    forgeCounter: i.forgeCounter,
    affixes: i.affixes,
    unprovenanced: i.unprovenanced,
    locked: i.locked,
    inWarehouse: i.inWarehouse,
    onShelf: i.onShelf,
    holdUntil: i.holdUntil ?? null,
    awakening: i.awakening ?? null,
  };
}

/** The item as it was (audit and history): its view plus the fields the view leaves out. */
function itemSnapshot(i: ItemInstance, settings: TradingSettings) {
  return {
    ...itemView(i, tradingSwitchesOf(settings)),
    seed: i.seed,
    effectRoll: i.effectRoll ?? null,
    tradedCount: i.tradedCount,
    characterId: i.characterId,
  };
}

const bundleOf = (m: Partial<Record<MaterialId, number>> | undefined): MaterialBundle =>
  cleanSideMaterials(m ?? {});

const sideTotal = (s: { gold: number; materials: MaterialBundle; itemIds: string[] }) =>
  s.gold > 0 || s.itemIds.length > 0 || Object.keys(s.materials).length > 0;

interface CleanSide {
  itemIds: string[];
  gold: number;
  materials: MaterialBundle;
}

function cleanSide(input: SideInput | undefined): CleanSide {
  return {
    itemIds: [...(input?.itemIds ?? [])],
    gold: input?.gold ?? 0,
    materials: bundleOf(input?.materials),
  };
}

export async function lockTradeOfferCounters(tx: Executor, accountIds: string[]): Promise<void> {
  for (const id of [...new Set(accountIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${TRADE_OFFER_LOCK(id)}, 0))`,
    );
  }
}

/** Share-locks account rows (in id order); the actor's is already held by `tradeWrite`. */
export async function shareLockAccounts(tx: Executor, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id)).for('share');
  }
}

async function openOfferCounts(tx: Executor, senderId: string, receiverId: string) {
  const [row] = await tx
    .select({
      sent: sql<number>`count(*) filter (where ${tradeOffers.senderAccountId} = ${senderId})`,
      received: sql<number>`count(*) filter (where ${tradeOffers.receiverAccountId} = ${receiverId})`,
    })
    .from(tradeOffers)
    .where(
      and(
        eq(tradeOffers.status, 'open'),
        or(
          eq(tradeOffers.senderAccountId, senderId),
          eq(tradeOffers.receiverAccountId, receiverId),
        ),
      ),
    );
  return { sent: Number(row?.sent ?? 0), received: Number(row?.received ?? 0) };
}

export async function loadLines(db: Executor, offerIds: string[]): Promise<TradeOfferLine[]> {
  if (offerIds.length === 0) return [];
  return db
    .select()
    .from(tradeOfferLines)
    .where(inArray(tradeOfferLines.offerId, offerIds))
    .orderBy(asc(tradeOfferLines.id));
}

interface OfferSides {
  give: { itemIds: string[]; gold: number; materials: MaterialBundle; snapshots: ItemView[] };
  ask: { itemIds: string[]; gold: number; materials: MaterialBundle; snapshots: ItemView[] };
}

function sidesOf(lines: readonly TradeOfferLine[]): OfferSides {
  const empty = () => ({
    itemIds: [] as string[],
    gold: 0,
    materials: {} as MaterialBundle,
    snapshots: [] as ItemView[],
  });
  const out: OfferSides = { give: empty(), ask: empty() };
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

/** Facts of one side from its snapshots (for voiding by switch: categories and kinds). */
function sideFactsFromSnapshots(s: OfferSides['give']): TradeSideFacts {
  return {
    items: s.snapshots.map((v) => ({
      id: v.id,
      rarityId: v.rarityId,
      variant: v.variant,
      setId: v.setId,
      source: v.source,
    })),
    gold: s.gold,
    materials: s.materials,
  };
}

async function lockOfferRow(tx: Transaction, offerId: string): Promise<TradeOffer | null> {
  const [row] = await tx
    .select()
    .from(tradeOffers)
    .where(eq(tradeOffers.id, offerId))
    .for('update');
  return row ?? null;
}

const notFound = () => new ApiError(404, 'not_found', 'No such offer.');

function offerClosed(o: TradeOffer): ApiError {
  return new ApiError(409, 'offer_closed', 'This offer has already ended.', { status: o.status });
}

// ---------------------------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------------------------

export interface SendInput {
  me: { id: string };
  standing: TradeStanding;
  settings: TradingSettings;
  now: Date;
  receiver: { id: string };
  characterId: string;
  receiverCharacterId?: string | undefined;
  give?: SideInput;
  ask?: SideInput;
}

/**
 * Sends an offer: checks everything (`tradeDecision('send')` with both standings, the relation,
 * the contents; the open-offer limits; the caps, checked not reserved), then moves the sender's
 * side into escrow. Returns the new offer's id.
 */
export async function sendOffer(
  tx: Transaction,
  input: SendInput,
  activity: ActivityOptions,
): Promise<string> {
  const { me, settings, now, receiver } = input;
  const give = cleanSide(input.give);
  const ask = cleanSide(input.ask);
  if (receiver.id === me.id) {
    throw new TradeRefusedError([{ check: 'self', party: 'pair' }], []);
  }
  await shareLockAccounts(tx, [receiver.id]);
  await lockTradeOfferCounters(tx, [me.id, receiver.id]);
  // T.7 (exploit review F5): both accounts' social locks, the ones a block, an unfriend and the
  // guild actions take, so the relation read below can't go stale before this offer commits (a
  // block landing in between would miss the offer and leave it open). Holders of these locks
  // take account rows only `for share`, before them, so no cycle.
  await lockSocialAccounts(tx, [me.id, receiver.id]);
  // T.7 (F1, F2): the pair first. Without a qualifying relation nothing about the receiver (their
  // standing, heroes or items) is read, so a refusal can't describe them.
  const relation = await loadTradeRelation(tx, me.id, receiver.id);
  const theirs = await hiddenCounterpart(tx, {
    actor: input.standing,
    relation,
    settings,
    now,
    otherAccountId: receiver.id,
  });
  if (theirs === null) {
    refuseUnless(
      tradeDecision({
        action: 'send',
        settings,
        now,
        actor: input.standing,
        counterpart: null,
        relation,
      }),
    );
  }
  const hero = await lockOwnedCharacter(tx, me.id, input.characterId, activity);

  // The sender's items: every item of the hero, locked (the inventory order).
  const heroItems = await tx
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, hero.id))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id))
    .for('update');
  const giveRows = give.itemIds.map((id) => {
    const row = heroItems.find((i) => i.id === id);
    if (!row) throw new ApiError(404, 'not_found', 'No such item.', { itemId: id });
    if (row.escrowOfferId) throw itemInAnotherOffer(id);
    return row;
  });

  // The receiver's hero: needed when asking for items (they are that hero's).
  let receiverHero: Character | null = null;
  if (input.receiverCharacterId) {
    const [row] = await tx
      .select()
      .from(characters)
      .where(
        and(
          eq(characters.id, input.receiverCharacterId),
          eq(characters.accountId, receiver.id),
          isNull(characters.deletedAt),
        ),
      );
    if (!row) throw characterNotFound();
    receiverHero = row;
  }
  if (ask.itemIds.length > 0 && !receiverHero) {
    throw new ApiError(400, 'hero_required', 'Choose which of their heroes you ask items from.');
  }
  const askRows: ItemInstance[] = [];
  if (ask.itemIds.length > 0) {
    const rows = await tx
      .select()
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, receiverHero!.id),
          inArray(itemInstances.id, ask.itemIds),
        ),
      );
    for (const id of ask.itemIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new ApiError(404, 'not_found', 'No such item.', { itemId: id });
      if (row.escrowOfferId) throw itemInAnotherOffer(id);
      askRows.push(row);
    }
  }

  const facts: TradeOfferFacts = {
    give: { items: giveRows.map(itemFacts), gold: give.gold, materials: give.materials },
    ask: { items: askRows.map(itemFacts), gold: ask.gold, materials: ask.materials },
  };
  const decision = tradeDecision({
    action: 'send',
    settings,
    now,
    actor: input.standing,
    counterpart: theirs,
    relation,
    offer: facts,
  });
  refuseUnless(decision);

  // The sender's side must be the hero's own, unheld value.
  const held = await heldValueOf(tx, hero.id, now);
  if (give.gold > hero.gold - held.gold) {
    throw new ApiError(422, 'insufficient_gold', 'Not enough gold.', {
      required: give.gold,
      held: hero.gold,
      onHold: held.gold,
      spendable: Math.max(0, hero.gold - held.gold),
    });
  }
  const stock = await loadMaterialBundle(tx, hero.id);
  for (const [id, q] of Object.entries(give.materials) as [MaterialId, number][]) {
    const spendable = (stock[id] ?? 0) - (held.materials[id] ?? 0);
    if (q > spendable) {
      throw new ApiError(422, 'insufficient_materials', 'Not enough materials.', {
        materialId: id,
        needed: q,
        available: stock[id] ?? 0,
        onHold: held.materials[id] ?? 0,
      });
    }
  }

  // Open offers (counted from the offers themselves, under both accounts' offer locks).
  const open = await openOfferCounts(tx, me.id, receiver.id);
  const mine = openOfferRefusal(open, settings.limits, 'sender');
  if (mine) {
    throw new ApiError(
      409,
      'open_offer_limit',
      `You have ${mine.open} open offers; that is the most you can have at once. Cancel one or wait for an answer.`,
      { party: 'you', open: mine.open, max: mine.max },
    );
  }
  if (openOfferRefusal(open, settings.limits, 'receiver')) {
    throw new ApiError(
      409,
      'open_offer_limit',
      'They have too many open offers to answer right now. Try again later.',
      { party: 'them' },
    );
  }
  // Caps: checked now (refused up front), counted only at accept (T.4).
  const capRefusals = [];
  // T.7 (F3): only the sender's own. Checking the receiver's here let a sender binary-search
  // what a friend received this week; their caps are checked at accept, where they see their own.
  for (const [party, accountId, role] of [['you', me.id, 'sender']] as const) {
    const used = await readTradeCounters(tx, accountId, now);
    for (const r of checkTradeCaps({
      used,
      adding: tradeCapIncrements(facts, role),
      limits: settings.limits,
      now,
    })) {
      capRefusals.push({ ...r, party });
    }
  }
  if (capRefusals.length > 0) throw tradeCapError(capRefusals);

  // Escrow.
  const offerId = uuidv7();
  const kind = tradeRelationKind(relation);
  await tx.insert(tradeOffers).values({
    id: offerId,
    senderAccountId: me.id,
    receiverAccountId: receiver.id,
    senderCharacterId: hero.id,
    receiverCharacterId: receiverHero?.id ?? null,
    status: 'open',
    relation: kind,
    expiresAt: offerExpiresAt(now),
    createdAt: now,
  });
  const lines = [
    ...giveRows.map((r) => itemLine(offerId, 'give', r, settings)),
    ...askRows.map((r) => itemLine(offerId, 'ask', r, settings)),
    ...materialLines(offerId, 'give', give.materials),
    ...materialLines(offerId, 'ask', ask.materials),
    ...goldLine(offerId, 'give', give.gold),
    ...goldLine(offerId, 'ask', ask.gold),
  ];
  if (lines.length > 0) await tx.insert(tradeOfferLines).values(lines);
  if (giveRows.length > 0) {
    const escrowed = await tx
      .update(itemInstances)
      .set({ escrowOfferId: offerId })
      .where(
        and(
          eq(itemInstances.characterId, hero.id),
          inArray(itemInstances.id, give.itemIds),
          isNull(itemInstances.escrowOfferId),
          isNull(itemInstances.equippedSlot),
          eq(itemInstances.inWarehouse, false),
          eq(itemInstances.onShelf, false),
          eq(itemInstances.locked, false),
          or(isNull(itemInstances.holdUntil), lte(itemInstances.holdUntil, now)),
        ),
      )
      .returning({ id: itemInstances.id });
    if (escrowed.length !== giveRows.length) throw conflict();
  }
  let after = hero;
  if (give.gold > 0) after = await changeGold(tx, hero, -give.gold, now);
  if (Object.keys(give.materials).length > 0) {
    await changeMaterialsTx(tx, hero.id, negate(give.materials), now);
  }
  const materialsAfter = await loadMaterialBundle(tx, hero.id);
  await writeAudit(tx, {
    event: 'trade.offer',
    accountId: me.id,
    characterId: hero.id,
    data: {
      offerId,
      to: receiver.id,
      toCharacterId: receiverHero?.id ?? null,
      relation: kind,
      expiresAt: offerExpiresAt(now).toISOString(),
      give: {
        items: giveRows.map((r) => itemSnapshot(r, settings)),
        gold: give.gold,
        materials: give.materials,
      },
      ask: {
        items: askRows.map((r) => itemSnapshot(r, settings)),
        gold: ask.gold,
        materials: ask.materials,
      },
      goldAfter: after.gold,
      materialsAfter: pick(materialsAfter, give.materials),
    },
  });
  // Ticket 8.5: the receiver's inbox (never from a test account or across a block).
  await notifyTx(tx, {
    accountId: receiver.id,
    kind: 'trade.received',
    data: { offerId },
    now,
    from: me.id,
  });
  return offerId;
}

function itemInAnotherOffer(itemId: string): ApiError {
  return new ApiError(
    409,
    'item_in_offer',
    'This item is already in a trade offer. Cancel that offer to use it again.',
    { itemId },
  );
}

function refuseUnless(decision: TradeDecision): void {
  if (decision.allowed) return;
  throw new TradeRefusedError(
    decision.refusals,
    decision.refusals.filter((r) => r.flag && r.itemId).map((r) => r.itemId!),
  );
}

const negate = (m: MaterialBundle): MaterialBundle =>
  Object.fromEntries(Object.entries(m).map(([k, n]) => [k, -n!]));

const pick = (m: MaterialBundle, keys: MaterialBundle) =>
  Object.fromEntries(Object.keys(keys).map((k) => [k, m[k as MaterialId] ?? 0]));

function itemLine(offerId: string, side: 'give' | 'ask', row: ItemInstance, s: TradingSettings) {
  return {
    id: uuidv7(),
    offerId,
    side,
    kind: 'item' as const,
    itemId: row.id,
    materialId: null,
    amount: 1,
    snapshot: itemView(row, tradingSwitchesOf(s)) as unknown as Record<string, unknown>,
  };
}

function materialLines(offerId: string, side: 'give' | 'ask', m: MaterialBundle) {
  return (Object.entries(m) as [MaterialId, number][]).map(([materialId, amount]) => ({
    id: uuidv7(),
    offerId,
    side,
    kind: 'material' as const,
    itemId: null,
    materialId,
    amount,
    snapshot: null,
  }));
}

function goldLine(offerId: string, side: 'give' | 'ask', gold: number) {
  return gold > 0
    ? [
        {
          id: uuidv7(),
          offerId,
          side,
          kind: 'gold' as const,
          itemId: null,
          materialId: null,
          amount: gold,
          snapshot: null,
        },
      ]
    : [];
}

// ---------------------------------------------------------------------------------------------
// Ending without a trade: cancel, decline, expire, void
// ---------------------------------------------------------------------------------------------

export type OfferEnd = 'cancelled' | 'declined' | 'expired' | 'void';

const END_EVENT: Record<OfferEnd, string> = {
  cancelled: 'trade.cancel',
  declined: 'trade.decline',
  expired: 'trade.expire',
  void: 'trade.void',
};

export interface EndDetail {
  /** The account that acted (cancel, decline; the moderator or admin for a void). */
  by?: string | null;
  cause?: TradeVoidCause;
  switches?: TradingSwitchPath[];
  sanction?: string;
}

/**
 * Ends a locked, open offer without a trade: everything in escrow goes back to the sender's hero
 * (items over pack capacity if need be, like B.2's valuable drops), the offer closes, and one audit
 * row records it. Nothing is held: nothing changed hands.
 */
export async function endOffer(
  tx: Transaction,
  offer: TradeOffer,
  end: OfferEnd,
  detail: EndDetail,
  now: Date,
  activity: ActivityOptions,
): Promise<void> {
  if (offer.status !== 'open') throw offerClosed(offer);
  const hero = await lockOwnedCharacter(
    tx,
    offer.senderAccountId,
    offer.senderCharacterId,
    activity,
  );
  const sides = sidesOf(await loadLines(tx, [offer.id]));
  const items = await tx
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.escrowOfferId, offer.id))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id))
    .for('update');
  if (items.length !== sides.give.itemIds.length) throw conflict();
  if (items.length > 0) {
    const back = await tx
      .update(itemInstances)
      .set({ escrowOfferId: null })
      .where(eq(itemInstances.escrowOfferId, offer.id))
      .returning({ id: itemInstances.id });
    if (back.length !== items.length) throw conflict();
  }
  let after = hero;
  if (sides.give.gold > 0) after = await changeGold(tx, hero, sides.give.gold, now);
  if (Object.keys(sides.give.materials).length > 0) {
    await changeMaterialsTx(tx, hero.id, sides.give.materials, now);
  }
  const closed = await tx
    .update(tradeOffers)
    .set({
      status: end,
      closedAt: now,
      ...(end === 'void'
        ? {
            voidReason: detail.cause ?? 'switch',
            voidDetail: {
              ...(detail.switches ? { switches: detail.switches } : {}),
              ...(detail.sanction ? { sanction: detail.sanction } : {}),
            },
          }
        : {}),
    })
    .where(and(eq(tradeOffers.id, offer.id), eq(tradeOffers.status, 'open')))
    .returning({ id: tradeOffers.id });
  if (closed.length !== 1) throw conflict();
  const materialsAfter = await loadMaterialBundle(tx, hero.id);
  await writeAudit(tx, {
    event: END_EVENT[end],
    accountId: offer.senderAccountId,
    characterId: hero.id,
    data: {
      offerId: offer.id,
      to: offer.receiverAccountId,
      by: detail.by ?? null,
      ...(end === 'void' ? { reason: detail.cause ?? 'switch' } : {}),
      ...(detail.switches ? { switches: detail.switches } : {}),
      ...(detail.sanction ? { sanction: detail.sanction } : {}),
      returned: {
        items: items.map((i) => i.id),
        gold: sides.give.gold,
        materials: sides.give.materials,
      },
      goldAfter: after.gold,
      materialsAfter: pick(materialsAfter, sides.give.materials),
    },
  });
  if (end === 'void') {
    // Ticket 8.5: both sides learn the offer was voided (by a switch, a sanction or staff).
    const reason = detail.cause ?? 'switch';
    for (const [accountId, side] of [
      [offer.senderAccountId, 'sent'],
      [offer.receiverAccountId, 'received'],
    ] as const) {
      await notifyTx(tx, {
        accountId,
        kind: 'trade.voided',
        data: { offerId: offer.id, reason, side },
        now,
      });
    }
  }
}

/** Cancel (the sender) or decline (the receiver). Past its expiry, the offer expires instead. */
export async function stepAway(
  tx: Transaction,
  input: { me: string; offerId: string; action: 'cancel' | 'decline'; now: Date },
  activity: ActivityOptions,
): Promise<void> {
  const offer = await lockOfferRow(tx, input.offerId);
  const mine =
    offer &&
    (input.action === 'cancel'
      ? offer.senderAccountId === input.me
      : offer.receiverAccountId === input.me);
  if (!offer || !mine) {
    // The other party's own action, or someone else's offer: the same answer as a missing one.
    throw notFound();
  }
  if (offer.status !== 'open') throw offerClosed(offer);
  const end: OfferEnd = isOfferExpired(offer.expiresAt, input.now)
    ? 'expired'
    : input.action === 'cancel'
      ? 'cancelled'
      : 'declined';
  await endOffer(tx, offer, end, { by: end === 'expired' ? null : input.me }, input.now, activity);
}

/** Voids every listed open offer (locked in id order first). Returns how many were voided. */
export async function voidOffers(
  tx: Transaction,
  offerIds: string[],
  detail: (offer: TradeOffer, lines: TradeOfferLine[]) => EndDetail | null,
  now: Date,
  activity: ActivityOptions,
): Promise<number> {
  const ids = [...new Set(offerIds)].sort();
  if (ids.length === 0) return 0;
  const locked = await tx
    .select()
    .from(tradeOffers)
    .where(and(inArray(tradeOffers.id, ids), eq(tradeOffers.status, 'open')))
    .orderBy(asc(tradeOffers.id))
    .for('update');
  const lines = await loadLines(
    tx,
    locked.map((o) => o.id),
  );
  const ending = locked.flatMap((offer) => {
    if (offer.status !== 'open') return [];
    const d = detail(
      offer,
      lines.filter((l) => l.offerId === offer.id),
    );
    return d ? [{ offer, d }] : [];
  });
  // T.7 (exploit review F4): every sender hero, in hero-id order, before any escrow goes back.
  // `endOffer` locks one offer's hero at a time in offer order, which against an accept or a
  // reversal (offer → heroes in id order) could close a cycle; re-locking a held row is free.
  const heroes = [
    ...new Map(ending.map(({ offer }) => [offer.senderCharacterId, offer.senderAccountId])),
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [heroId, accountId] of heroes) {
    await lockOwnedCharacter(tx, accountId, heroId, activity);
  }
  for (const { offer, d } of ending) await endOffer(tx, offer, 'void', d, now, activity);
  return ending.length;
}

async function openOfferIdsOf(tx: Executor, accountIds: string[]): Promise<TradeOffer[]> {
  if (accountIds.length === 0) return [];
  return tx
    .select()
    .from(tradeOffers)
    .where(
      and(
        eq(tradeOffers.status, 'open'),
        or(
          inArray(tradeOffers.senderAccountId, accountIds),
          inArray(tradeOffers.receiverAccountId, accountIds),
        ),
      ),
    );
}

/** T.2's seam: switches turned off void the open offers they close. */
export async function voidForSwitches(
  tx: Transaction,
  off: TradingSwitchPath[],
  actorAccountId: string,
  now: Date,
  activity: ActivityOptions,
): Promise<number> {
  if (off.length === 0) return 0;
  const open = await tx
    .select({ id: tradeOffers.id })
    .from(tradeOffers)
    .where(eq(tradeOffers.status, 'open'));
  return voidOffers(
    tx,
    open.map((o) => o.id),
    (_offer, lines) => {
      const sides = sidesOf(lines);
      const closing = switchesVoiding(
        off,
        offerContents([sideFactsFromSnapshots(sides.give), sideFactsFromSnapshots(sides.ask)]),
      );
      return closing.length > 0 ? { cause: 'switch', switches: closing, by: actorAccountId } : null;
    },
    now,
    activity,
  );
}

/** T.4's seam: a trade restriction or a suspension voids every open offer of the subject. */
export async function voidForSanction(
  tx: Transaction,
  subjectId: string,
  sanction: string,
  actorAccountId: string,
  now: Date,
  activity: ActivityOptions,
): Promise<number> {
  const open = await openOfferIdsOf(tx, [subjectId]);
  return voidOffers(
    tx,
    open.map((o) => o.id),
    () => ({ cause: 'sanction', sanction, by: actorAccountId }),
    now,
    activity,
  );
}

/**
 * A relation ended (a block, an unfriend, a guild left, a kick, a disband): every open offer of
 * these accounts whose pair no longer qualifies (blocked, no relation, or one under 7 days) is
 * voided. Offers still covered by another qualifying relation (friends and guildmates) stay open.
 */
export async function voidForRelations(
  tx: Transaction,
  accountIds: string[],
  now: Date,
  activity: ActivityOptions,
): Promise<number> {
  const open = await openOfferIdsOf(tx, accountIds);
  const verdicts = new Map<string, EndDetail | null>();
  for (const o of open) {
    const relation = await loadTradeRelation(tx, o.senderAccountId, o.receiverAccountId);
    const pair = tradeDecision({
      action: 'send',
      settings: { ...PAIR_ONLY },
      now,
      actor: ELIGIBLE,
      counterpart: null,
      relation,
    }).refusals.filter((r) => r.party === 'pair');
    verdicts.set(
      o.id,
      pair.length === 0 ? null : { cause: relation.blocked ? 'block' : 'relation' },
    );
  }
  return voidOffers(
    tx,
    open.map((o) => o.id),
    (offer) => verdicts.get(offer.id) ?? null,
    now,
    activity,
  );
}

/** Settings and a standing that pass everything but the pair checks (relation-only verdicts). */
const PAIR_ONLY: TradingSettings = { ...DEFAULT_TRADING_SETTINGS, trading: true };
const ELIGIBLE: TradeStanding = {
  createdAt: new Date(0),
  highestHeroLevel: 1_000,
  emailVerified: true,
  sanctions: [],
};

/**
 * The deletion seam (docs/TRADING.md "2. … Format", step 5): hero and account deletion don't
 * exist yet. Whatever deletes a hero must call this first (in its transaction): it voids the
 * hero's open offers, returning escrow to the sender. The offers' foreign keys refuse to delete a
 * hero or account an offer still names, so escrow can never be lost silently.
 */
export async function voidForDeletion(
  tx: Transaction,
  characterId: string,
  now: Date,
  activity: ActivityOptions,
): Promise<number> {
  const open = await tx
    .select({ id: tradeOffers.id })
    .from(tradeOffers)
    .where(
      and(
        eq(tradeOffers.status, 'open'),
        or(
          eq(tradeOffers.senderCharacterId, characterId),
          eq(tradeOffers.receiverCharacterId, characterId),
        ),
      ),
    );
  return voidOffers(
    tx,
    open.map((o) => o.id),
    () => ({ cause: 'deletion' }),
    now,
    activity,
  );
}

// ---------------------------------------------------------------------------------------------
// Accept: the swap
// ---------------------------------------------------------------------------------------------

export interface AcceptInput {
  me: { id: string };
  standing: TradeStanding;
  settings: TradingSettings;
  now: Date;
  offerId: string;
  characterId?: string | undefined;
}

/**
 * Accepts an offer: checks everything again, escrows the receiver's side and swaps both sides,
 * all or nothing, in this one transaction (see the lock order above). Traded items become bound
 * to their new account (`traded_count + 1`) and are held for 72 hours; received gold and
 * materials get a `trade_holds` row. Commits T.4's cap counters.
 */
export async function acceptOffer(
  tx: Transaction,
  input: AcceptInput,
  activity: ActivityOptions,
): Promise<void> {
  const { me, settings, now } = input;
  const peek = await tx
    .select({ sender: tradeOffers.senderAccountId, receiver: tradeOffers.receiverAccountId })
    .from(tradeOffers)
    .where(eq(tradeOffers.id, input.offerId));
  if (!peek[0] || peek[0].receiver !== me.id) throw notFound();
  // 1. The other party's account row (ours is held by `tradeWrite`), before any offer row.
  await shareLockAccounts(tx, [peek[0].sender]);
  // 3. The offer.
  const offer = await lockOfferRow(tx, input.offerId);
  if (!offer || offer.receiverAccountId !== me.id) throw notFound();
  if (offer.status !== 'open') throw offerClosed(offer);
  if (isOfferExpired(offer.expiresAt, now)) {
    throw new ApiError(409, 'offer_expired', 'This offer has expired.', {
      expiresAt: offer.expiresAt.toISOString(),
    });
  }
  const receiverHeroId = offer.receiverCharacterId ?? input.characterId;
  if (!receiverHeroId) {
    throw new ApiError(400, 'hero_required', 'Choose the hero who receives this offer.');
  }
  if (offer.receiverCharacterId && input.characterId && input.characterId !== receiverHeroId) {
    throw new ApiError(
      409,
      'wrong_hero',
      'This offer asks for items of another of your heroes; accept it with that hero.',
    );
  }
  // 4. Both heroes, in id order (each settled first).
  const heroes = new Map<string, Character>();
  for (const [accountId, heroId] of [
    [offer.senderAccountId, offer.senderCharacterId],
    [me.id, receiverHeroId],
  ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)) as [string, string][]) {
    heroes.set(heroId, await lockOwnedCharacter(tx, accountId, heroId, activity));
  }
  let senderHero = heroes.get(offer.senderCharacterId)!;
  let receiverHero = heroes.get(receiverHeroId)!;
  const sides = sidesOf(await loadLines(tx, [offer.id]));

  // 5. Items: both sides' rows, in one statement, in the inventory order.
  const ids = [...sides.give.itemIds, ...sides.ask.itemIds];
  const rows = ids.length
    ? await tx
        .select()
        .from(itemInstances)
        .where(inArray(itemInstances.id, ids))
        .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id))
        .for('update')
    : [];
  const giveRows = sides.give.itemIds.map((id) => {
    const r = rows.find((x) => x.id === id);
    if (!r || r.escrowOfferId !== offer.id || r.characterId !== senderHero.id) throw conflict();
    return r;
  });
  const askRows = sides.ask.itemIds.map((id) => {
    const r = rows.find((x) => x.id === id);
    if (!r || r.characterId !== receiverHero.id) {
      throw new ApiError(409, 'item_gone', 'An item this offer asks for is no longer there.', {
        itemId: id,
      });
    }
    if (r.escrowOfferId) throw itemInAnotherOffer(id);
    return r;
  });

  // Everything again, from the facts the locks protect: switches, relation, both standings,
  // contents (binding, provenance, lock, location and hold of the receiver's items).
  const facts: TradeOfferFacts = {
    give: {
      items: giveRows.map(itemFacts),
      gold: sides.give.gold,
      materials: sides.give.materials,
    },
    ask: { items: askRows.map(itemFacts), gold: sides.ask.gold, materials: sides.ask.materials },
  };
  const relation = await loadTradeRelation(tx, me.id, offer.senderAccountId);
  const theirs = await hiddenCounterpart(tx, {
    actor: input.standing,
    relation,
    settings,
    now,
    otherAccountId: offer.senderAccountId,
  });
  refuseUnless(
    tradeDecision({
      action: 'accept',
      settings,
      now,
      actor: input.standing,
      counterpart: theirs,
      relation,
      offer: facts,
    }),
  );
  // The receiver's side must be their hero's own, unheld value.
  const held = await heldValueOf(tx, receiverHero.id, now);
  if (sides.ask.gold > receiverHero.gold - held.gold) {
    throw new ApiError(
      422,
      'insufficient_gold',
      'Your hero doesn’t have the gold this offer asks for.',
      {
        required: sides.ask.gold,
        held: receiverHero.gold,
        onHold: held.gold,
        spendable: Math.max(0, receiverHero.gold - held.gold),
      },
    );
  }
  const stock = await loadMaterialBundle(tx, receiverHero.id);
  for (const [id, q] of Object.entries(sides.ask.materials) as [MaterialId, number][]) {
    if (q > (stock[id] ?? 0) - (held.materials[id] ?? 0)) {
      throw new ApiError(
        422,
        'insufficient_materials',
        'Your hero doesn’t have the materials this offer asks for.',
        {
          materialId: id,
          needed: q,
          available: stock[id] ?? 0,
          onHold: held.materials[id] ?? 0,
        },
      );
    }
  }

  // Ticket T.7: what changes account leaves the giving hero's arena defence (only an item worn
  // before T.1 recorded wear could be in one; a defence row lock, before the counter locks).
  await withdrawFromDefence(tx, senderHero.id, giveRows);
  await withdrawFromDefence(tx, receiverHero.id, askRows);

  // 6. The caps, last (T.4): both accounts, all or nothing.
  await commitTradeCounters(tx, {
    actorId: me.id,
    limits: settings.limits,
    now,
    parties: [
      { accountId: offer.senderAccountId, adding: tradeCapIncrements(facts, 'sender') },
      { accountId: me.id, adding: tradeCapIncrements(facts, 'receiver') },
    ],
  });

  // The swap.
  const until = holdUntilAt(now);
  const moveItems = async (
    rowsToMove: ItemInstance[],
    from: Character,
    to: Character,
    escrowed: boolean,
  ) => {
    if (rowsToMove.length === 0) return [];
    const moved = await tx
      .update(itemInstances)
      .set({
        characterId: to.id,
        escrowOfferId: null,
        binding: 'account',
        boundAccountId: to.accountId,
        tradedCount: sql`${itemInstances.tradedCount} + 1`,
        holdUntil: until,
      })
      .where(
        and(
          inArray(
            itemInstances.id,
            rowsToMove.map((r) => r.id),
          ),
          eq(itemInstances.characterId, from.id),
          escrowed
            ? eq(itemInstances.escrowOfferId, offer.id)
            : isNull(itemInstances.escrowOfferId),
          isNull(itemInstances.equippedSlot),
          eq(itemInstances.inWarehouse, false),
          eq(itemInstances.onShelf, false),
          eq(itemInstances.locked, false),
        ),
      )
      .returning();
    if (moved.length !== rowsToMove.length) throw conflict();
    return moved;
  };
  await moveItems(giveRows, senderHero, receiverHero, true);
  await moveItems(askRows, receiverHero, senderHero, false);
  // Gold and materials: the receiver pays the ask first (hold-aware), then both receive.
  if (sides.ask.gold > 0) receiverHero = await changeGold(tx, receiverHero, -sides.ask.gold, now);
  if (Object.keys(sides.ask.materials).length > 0) {
    await changeMaterialsTx(tx, receiverHero.id, negate(sides.ask.materials), now);
  }
  if (sides.give.gold > 0) receiverHero = await changeGold(tx, receiverHero, sides.give.gold, now);
  if (Object.keys(sides.give.materials).length > 0) {
    await changeMaterialsTx(tx, receiverHero.id, sides.give.materials, now);
  }
  if (sides.ask.gold > 0) senderHero = await changeGold(tx, senderHero, sides.ask.gold, now);
  if (Object.keys(sides.ask.materials).length > 0) {
    await changeMaterialsTx(tx, senderHero.id, sides.ask.materials, now);
  }
  // The holds: one per receiving hero, covering everything it got.
  const holds: { hero: Character; side: OfferSides['give'] }[] = [
    { hero: receiverHero, side: sides.give },
    { hero: senderHero, side: sides.ask },
  ];
  for (const h of holds) {
    if (!sideTotal(h.side)) continue;
    await tx.insert(tradeHolds).values({
      id: uuidv7(),
      characterId: h.hero.id,
      accountId: h.hero.accountId,
      offerId: offer.id,
      gold: h.side.gold,
      materials: h.side.materials,
      itemIds: h.side.itemIds,
      heldUntil: until,
      createdAt: now,
    });
  }
  const closed = await tx
    .update(tradeOffers)
    .set({ status: 'accepted', closedAt: now, receiverCharacterId: receiverHero.id })
    .where(and(eq(tradeOffers.id, offer.id), eq(tradeOffers.status, 'open')))
    .returning({ id: tradeOffers.id });
  if (closed.length !== 1) throw conflict();

  const kind = sideTotal(sides.ask) ? 'swap' : 'gift';
  const senderMaterials = await loadMaterialBundle(tx, senderHero.id);
  const receiverMaterials = await loadMaterialBundle(tx, receiverHero.id);
  const snap = (r: ItemInstance, to: Character) => ({
    ...itemSnapshot(r, settings),
    from: {
      accountId: r.characterId === senderHero.id ? offer.senderAccountId : me.id,
      characterId: r.characterId,
    },
    to: { accountId: to.accountId, characterId: to.id },
  });
  await writeAudit(tx, {
    event: 'trade.accept',
    accountId: me.id,
    characterId: receiverHero.id,
    data: {
      offerId: offer.id,
      kind,
      senderAccountId: offer.senderAccountId,
      senderCharacterId: senderHero.id,
      receiverAccountId: me.id,
      receiverCharacterId: receiverHero.id,
      holdUntil: until.toISOString(),
      give: {
        items: giveRows.map((r) => snap(r, receiverHero)),
        gold: sides.give.gold,
        materials: sides.give.materials,
      },
      ask: {
        items: askRows.map((r) => snap(r, senderHero)),
        gold: sides.ask.gold,
        materials: sides.ask.materials,
      },
      sender: {
        goldAfter: senderHero.gold,
        materialsAfter: pick(senderMaterials, { ...sides.ask.materials, ...sides.give.materials }),
      },
      receiver: {
        goldAfter: receiverHero.gold,
        materialsAfter: pick(receiverMaterials, {
          ...sides.ask.materials,
          ...sides.give.materials,
        }),
      },
    },
  });
  // Ticket 8.5: the sender's inbox.
  await notifyTx(tx, {
    accountId: offer.senderAccountId,
    kind: 'trade.accepted',
    data: { offerId: offer.id },
    now,
    from: me.id,
  });
  recordTelemetry(tx, now, tradeTelemetry(kind, giveRows, askRows, sides));
}

/** Telemetry of one completed trade (docs/TELEMETRY.md, ticket T.5). No ids, no names. */
function tradeTelemetry(
  kind: 'gift' | 'swap',
  giveRows: readonly ItemInstance[],
  askRows: readonly ItemInstance[],
  sides: OfferSides,
): TelemetryCount[] {
  const out: TelemetryCount[] = [{ metric: 'trade.complete', dims: [kind] }];
  for (const r of [...giveRows, ...askRows]) {
    out.push({ metric: 'trade.items', dims: [r.rarityId, r.variant ?? 'none'] });
    out.push({ metric: 'item.fate', dims: ['trade', 'traded', r.rarityId] });
  }
  const gold = sides.give.gold + sides.ask.gold;
  if (gold > 0) {
    out.push({ metric: 'gold.out', dims: ['trade', ''], amount: gold });
    out.push({ metric: 'gold.in', dims: ['trade', ''], amount: gold });
  }
  for (const side of [sides.give, sides.ask]) {
    for (const [id, q] of Object.entries(side.materials) as [MaterialId, number][]) {
      out.push({ metric: 'material.out', dims: ['trade', id], amount: q });
      out.push({ metric: 'material.in', dims: ['trade', id], amount: q });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time: expiry and release
// ---------------------------------------------------------------------------------------------

/**
 * Expires every open offer past its 48 hours and releases every hold past its 72 hours (each in its
 * own transaction, so one failure doesn't block the rest). `accountId` limits it to one account's
 * offers and holds (the inbox does that before answering). Exactly once: an expiry closes the offer
 * under its lock (`status = 'open'`), a release sets `released_at` only where it is still null.
 */
export async function sweepTrades(
  db: Database,
  now: Date,
  activity: ActivityOptions,
  { accountId, limit = 100 }: { accountId?: string; limit?: number } = {},
): Promise<{ expired: number; released: number }> {
  const party = accountId
    ? or(eq(tradeOffers.senderAccountId, accountId), eq(tradeOffers.receiverAccountId, accountId))
    : undefined;
  const due = await db
    .select({ id: tradeOffers.id })
    .from(tradeOffers)
    .where(and(eq(tradeOffers.status, 'open'), lte(tradeOffers.expiresAt, now), party))
    .orderBy(asc(tradeOffers.expiresAt))
    .limit(limit);
  let expired = 0;
  for (const { id } of due) {
    expired += await withTransaction(db, async (tx) => {
      const offer = await lockOfferRow(tx, id);
      if (!offer || offer.status !== 'open' || !isOfferExpired(offer.expiresAt, now)) return 0;
      await endOffer(tx, offer, 'expired', {}, now, activity);
      return 1;
    });
  }
  const holds = await db
    .select({ id: tradeHolds.id })
    .from(tradeHolds)
    .where(
      and(
        isNull(tradeHolds.releasedAt),
        lte(tradeHolds.heldUntil, now),
        accountId ? eq(tradeHolds.accountId, accountId) : undefined,
      ),
    )
    .orderBy(asc(tradeHolds.heldUntil))
    .limit(limit);
  let released = 0;
  for (const { id } of holds) {
    released += await withTransaction(db, (tx) => releaseHold(tx, id, now));
  }
  return { expired, released };
}

/** Releases one hold whose time has come: `released_at` and a `trade.release` row, once. */
export async function releaseHold(tx: Transaction, holdId: string, now: Date): Promise<number> {
  const [row] = await tx
    .update(tradeHolds)
    .set({ releasedAt: now })
    .where(
      and(eq(tradeHolds.id, holdId), isNull(tradeHolds.releasedAt), lte(tradeHolds.heldUntil, now)),
    )
    .returning();
  if (!row) return 0;
  await writeAudit(tx, {
    event: 'trade.release',
    accountId: row.accountId,
    characterId: row.characterId,
    data: {
      holdId: row.id,
      offerId: row.offerId,
      gold: row.gold,
      materials: row.materials,
      items: row.itemIds,
      heldUntil: row.heldUntil.toISOString(),
    },
  });
  // Ticket 8.5: what the account received is its own to use now.
  await notifyTx(tx, {
    accountId: row.accountId,
    kind: 'trade.released',
    data: { offerId: row.offerId, items: row.itemIds.length, gold: row.gold },
    now,
  });
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

interface ViewContext {
  people: Map<string, { handle: string; displayName: string | null }>;
  heroes: Map<string, TradeHeroView & { id: string; accountId: string }>;
  lines: TradeOfferLine[];
}

async function viewContext(db: Executor, offers: TradeOffer[], now: Date): Promise<ViewContext> {
  const accountIds = [...new Set(offers.flatMap((o) => [o.senderAccountId, o.receiverAccountId]))];
  const heroIds = [
    ...new Set(offers.flatMap((o) => [o.senderCharacterId, o.receiverCharacterId]).filter(Boolean)),
  ] as string[];
  const [people, hidden, heroRows, lines] = await Promise.all([
    accountIds.length
      ? db
          .select({ id: accounts.id, handle: accounts.handle, displayName: accounts.displayName })
          .from(accounts)
          .where(inArray(accounts.id, accountIds))
      : Promise.resolve([]),
    hiddenTargetKeys(
      db,
      accountIds.map((id) => profileFieldKey(id, 'displayName')),
      now,
    ),
    heroIds.length
      ? db
          .select({
            id: characters.id,
            accountId: characters.accountId,
            name: characters.name,
            classId: characters.classId,
            level: characters.level,
          })
          .from(characters)
          .where(inArray(characters.id, heroIds))
      : Promise.resolve([]),
    loadLines(
      db,
      offers.map((o) => o.id),
    ),
  ]);
  return {
    people: new Map(
      people.map((p) => [
        p.id,
        {
          handle: p.handle,
          displayName: hidden.has(profileFieldKey(p.id, 'displayName')) ? null : p.displayName,
        },
      ]),
    ),
    heroes: new Map(heroRows.map((h) => [h.id, h])),
    lines,
  };
}

function sideView(s: OfferSides['give']): TradeSideView {
  return { items: s.snapshots, gold: s.gold, materials: materialList(s.materials) };
}

function offerView(o: TradeOffer, me: string, ctx: ViewContext): TradeOfferView {
  const role = o.senderAccountId === me ? 'sender' : 'receiver';
  const other = role === 'sender' ? o.receiverAccountId : o.senderAccountId;
  const mineId = role === 'sender' ? o.senderCharacterId : o.receiverCharacterId;
  const theirsId = role === 'sender' ? o.receiverCharacterId : o.senderCharacterId;
  const hero = (id: string | null) => {
    const h = id ? ctx.heroes.get(id) : undefined;
    return h ? { name: h.name, classId: h.classId, level: h.level } : null;
  };
  const sides = sidesOf(ctx.lines.filter((l) => l.offerId === o.id));
  const mine = hero(mineId);
  return {
    id: o.id,
    status: o.status,
    role,
    with: ctx.people.get(other) ?? { handle: '', displayName: null },
    yourHero: mine && mineId ? { id: mineId, ...mine } : null,
    theirHero: hero(theirsId),
    give: sideView(sides.give),
    ask: sideView(sides.ask),
    gift: !sideTotal(sides.ask),
    createdAt: o.createdAt.toISOString(),
    expiresAt: o.expiresAt.toISOString(),
    closedAt: o.closedAt?.toISOString() ?? null,
    heldUntil:
      o.status === 'accepted' && o.closedAt && !o.reversedAt
        ? holdUntilAt(o.closedAt).toISOString()
        : null,
    endText:
      o.status === 'open' || o.status === 'accepted'
        ? null
        : tradeEndText(o.status, {
            ...(o.voidReason ? { cause: o.voidReason } : {}),
            ...(Array.isArray(o.voidDetail?.switches)
              ? { switches: o.voidDetail.switches as TradingSwitchPath[] }
              : {}),
          }),
    reversal: o.reversedAt
      ? { at: o.reversedAt.toISOString(), reason: o.reverseReason ?? '', text: TRADE_REVERSED_TEXT }
      : null,
  };
}

export async function offerViews(
  db: Executor,
  offers: TradeOffer[],
  me: string,
  now: Date,
): Promise<TradeOfferView[]> {
  const ctx = await viewContext(db, offers, now);
  return offers.map((o) => offerView(o, me, ctx));
}

/** One offer of `me` (as sender or receiver), or `404`. */
export async function loadOwnOffer(db: Executor, offerId: string, me: string): Promise<TradeOffer> {
  const [o] = await db.select().from(tradeOffers).where(eq(tradeOffers.id, offerId));
  if (!o || (o.senderAccountId !== me && o.receiverAccountId !== me)) throw notFound();
  return o;
}

export async function openOffersOf(db: Executor, me: string): Promise<TradeOffer[]> {
  return db
    .select()
    .from(tradeOffers)
    .where(
      and(
        eq(tradeOffers.status, 'open'),
        or(eq(tradeOffers.senderAccountId, me), eq(tradeOffers.receiverAccountId, me)),
      ),
    )
    .orderBy(desc(tradeOffers.createdAt), desc(tradeOffers.id));
}

/** Ended offers, newest first; `before` is the id of the last one already shown. */
export async function endedOffersOf(
  db: Executor,
  me: string,
  { before, limit }: { before?: string | undefined; limit: number },
): Promise<TradeOffer[]> {
  return db
    .select()
    .from(tradeOffers)
    .where(
      and(
        sql`${tradeOffers.status} <> 'open'`,
        or(eq(tradeOffers.senderAccountId, me), eq(tradeOffers.receiverAccountId, me)),
        before ? lt(tradeOffers.id, before) : undefined,
      ),
    )
    .orderBy(desc(tradeOffers.id))
    .limit(limit);
}

/** The account's holds still in force at `now`, per hero. */
export async function activeHoldsOf(
  db: Executor,
  accountId: string,
  now: Date,
): Promise<TradeHoldView[]> {
  const rows = await db
    .select({ hold: tradeHolds, heroName: characters.name })
    .from(tradeHolds)
    .innerJoin(characters, eq(characters.id, tradeHolds.characterId))
    .where(
      and(
        eq(tradeHolds.accountId, accountId),
        sql`${tradeHolds.heldUntil} > ${now}`,
        // Ticket T.6: a reversal ends the trade's holds early.
        isNull(tradeHolds.releasedAt),
      ),
    )
    .orderBy(asc(tradeHolds.heldUntil));
  return rows.map(({ hold, heroName }: { hold: TradeHold; heroName: string }) => ({
    characterId: hold.characterId,
    heroName,
    gold: hold.gold,
    materials: materialList(hold.materials),
    items: hold.itemIds.length,
    heldUntil: hold.heldUntil.toISOString(),
  }));
}
