import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  MATERIAL_IDS,
  TRADING_LIMITS,
  checkTradeCaps,
  isMaterialId,
  itemBinding,
  standingRefusals,
  tradeCapIncrements,
  tradeCapText,
  tradeDecision,
  tradeRelationKind,
  tradingSwitchesOf,
  visibleRelation,
  type MaterialBundle,
  type MaterialId,
  type TradeStanding,
  type TradingSettings,
} from '@worldforge/game-core';
import {
  accounts,
  characters,
  guildMembers,
  itemInstances,
  tradeOffers,
  type ItemInstance,
} from '../db/schema.js';
import { hiddenTargetKeys } from '../social/sanctions.js';
import { profileFieldKey } from '../social/targets.js';
import type { Executor } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { itemSchema, itemView, type ItemView } from '../inventory/routes.js';
import { isPackItem } from '../inventory/location.js';
import { loadMaterialBundle } from '../materials/store.js';
import { heldValueOf } from '../shelf/held.js';
import { accountBy } from '../social/friends.js';
import { friendIds, relationBetween } from '../social/relations.js';
import { materialList, materialListSchema, type MaterialStack } from '../economy/shared.js';
import { readTradeCounters } from './counters.js';
import { loadTradeRelation, loadTradeStanding } from './standing.js';
import { tradeWrite } from './trade-write.js';
import {
  TradeRefusedError,
  acceptOffer,
  activeHoldsOf,
  endedOffersOf,
  itemFacts,
  loadLines,
  loadOwnOffer,
  offerViews,
  openOffersOf,
  reasonView,
  sendOffer,
  stepAway,
  sweepTrades,
  voidForRelations,
  voidForSanction,
  voidForSwitches,
  type SideInput,
  type TradeOfferView,
} from './offers.js';

/**
 * Trade offer routes (ticket T.5, docs/API_CONVENTIONS.md "Trading", docs/TRADING.md "T.5 as
 * built"). Writes go through `tradeWrite` (the `trade` rate-limit class, an `Idempotency-Key`,
 * the actor's account row share-locked) and `tradeDecision`; reads count against 3.9's
 * per-account request limit. The inbox is polled (every 30 s while the screen is open) with an
 * ETag, so an unchanged inbox costs a `304`.
 *
 * Also registers T.5's listeners on the seams T.2 and T.4 left: a switch turned off voids the
 * offers it closes (in the saving transaction), a trade restriction or a suspension voids the
 * subject's offers (in the issuing transaction), and a relation that ends voids the offers that no
 * longer have a qualifying relation.
 */

const HISTORY_PAGE = 20;
const RECENT = 10;

const sideBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemIds: {
      type: 'array',
      maxItems: TRADING_LIMITS.itemsPerSide.max,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
    gold: { type: 'integer', minimum: 0, maximum: TRADING_LIMITS.goldPerOffer.max },
    materials: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        MATERIAL_IDS.map((id) => [id, { type: 'integer', minimum: 0, maximum: 1_000_000 }]),
      ),
    },
  },
} as const;

const sendBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'characterId'],
  properties: {
    to: { type: 'string', minLength: 1, maxLength: 64 },
    characterId: { type: 'string', format: 'uuid' },
    receiverCharacterId: { type: 'string', format: 'uuid' },
    give: sideBodySchema,
    ask: sideBodySchema,
  },
} as const;

interface SendBody {
  to: string;
  characterId: string;
  receiverCharacterId?: string;
  give?: SideInput;
  ask?: SideInput;
}

const offerParams = {
  type: 'object',
  required: ['offerId'],
  properties: { offerId: { type: 'string', format: 'uuid' } },
} as const;

const heroSchema = {
  type: ['object', 'null'],
  required: ['name', 'classId', 'level'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    classId: { type: 'string' },
    level: { type: 'integer' },
  },
} as const;

const sideSchema = {
  type: 'object',
  required: ['items', 'gold', 'materials'],
  properties: {
    items: { type: 'array', items: itemSchema },
    gold: { type: 'integer' },
    materials: materialListSchema,
  },
} as const;

const reasonSchema = {
  type: 'object',
  required: ['check', 'party', 'text'],
  properties: {
    check: { type: 'string' },
    party: { type: 'string' },
    text: { type: 'string' },
    metAt: { type: 'string' },
    side: { type: 'string' },
    itemId: { type: 'string' },
    kind: { type: 'string' },
    materialId: { type: 'string' },
  },
} as const;

export const offerSchema = {
  type: 'object',
  required: [
    'id',
    'status',
    'role',
    'with',
    'yourHero',
    'theirHero',
    'give',
    'ask',
    'gift',
    'createdAt',
    'expiresAt',
    'closedAt',
    'heldUntil',
    'endText',
  ],
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    role: { type: 'string', enum: ['sender', 'receiver'] },
    with: {
      type: 'object',
      required: ['handle', 'displayName'],
      properties: { handle: { type: 'string' }, displayName: { type: ['string', 'null'] } },
    },
    yourHero: heroSchema,
    theirHero: heroSchema,
    give: sideSchema,
    ask: sideSchema,
    gift: { type: 'boolean' },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    closedAt: { type: ['string', 'null'] },
    heldUntil: { type: ['string', 'null'] },
    endText: { type: ['string', 'null'] },
    // Ticket T.6: a moderator reversed the trade (both players see when and why).
    reversal: {
      anyOf: [
        {
          type: 'object',
          required: ['at', 'reason', 'text'],
          properties: {
            at: { type: 'string' },
            reason: { type: 'string' },
            text: { type: 'string' },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

const holdSchema = {
  type: 'object',
  required: ['characterId', 'heroName', 'gold', 'materials', 'items', 'heldUntil'],
  properties: {
    characterId: { type: 'string' },
    heroName: { type: 'string' },
    gold: { type: 'integer' },
    materials: materialListSchema,
    items: { type: 'integer' },
    heldUntil: { type: 'string' },
  },
} as const;

const inboxSchema = {
  type: 'object',
  required: ['open', 'received', 'sent', 'recent', 'holds', 'pollMs'],
  properties: {
    open: { type: 'boolean' },
    received: { type: 'array', items: offerSchema },
    sent: { type: 'array', items: offerSchema },
    recent: { type: 'array', items: offerSchema },
    holds: { type: 'array', items: holdSchema },
    pollMs: { type: 'integer' },
  },
} as const;

const detailSchema = {
  type: 'object',
  required: ['offer', 'decision'],
  properties: {
    offer: offerSchema,
    decision: {
      type: ['object', 'null'],
      required: ['allowed', 'reasons'],
      properties: { allowed: { type: 'boolean' }, reasons: { type: 'array', items: reasonSchema } },
    },
  },
} as const;

const heroesSchema = {
  type: 'object',
  required: ['heroes'],
  properties: {
    heroes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'classId', 'level', 'gold', 'heldGold', 'materials', 'items'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          classId: { type: 'string' },
          level: { type: 'integer' },
          gold: { type: 'integer' },
          heldGold: { type: 'integer' },
          materials: {
            type: 'array',
            items: {
              type: 'object',
              required: ['materialId', 'quantity', 'held'],
              properties: {
                materialId: { type: 'string' },
                quantity: { type: 'integer' },
                held: { type: 'integer' },
              },
            },
          },
          items: { type: 'array', items: itemSchema },
        },
      },
    },
  },
} as const;

const partnerSchema = {
  type: 'object',
  required: ['handle', 'displayName', 'relation', 'allowed', 'reasons'],
  properties: {
    handle: { type: 'string' },
    displayName: { type: ['string', 'null'] },
    relation: { type: 'string' },
    allowed: { type: 'boolean' },
    reasons: { type: 'array', items: reasonSchema },
    heroes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'classId', 'level', 'items'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          classId: { type: 'string' },
          level: { type: 'integer' },
          items: { type: 'array', items: itemSchema },
        },
      },
    },
  },
} as const;

/** The inbox is polled every 30 s while the Trading screen is open (well inside 3.9's limit). */
export const TRADE_INBOX_POLL_MS = 30_000;

export interface TradeHeroOption {
  id: string;
  name: string;
  classId: string;
  level: number;
  gold: number;
  heldGold: number;
  materials: (MaterialStack & { held: number })[];
  items: ItemView[];
}

/** Items a hero could put into an offer now (in the pack, tradeable, unlocked, not held). */
function offerable(items: readonly ItemInstance[], settings: TradingSettings, now: Date) {
  const switches = tradingSwitchesOf(settings);
  return items.filter(
    (i) =>
      isPackItem(i) &&
      !i.locked &&
      !i.unprovenanced &&
      !(i.holdUntil && i.holdUntil.getTime() > now.getTime()) &&
      itemBinding(i, switches).tradeable,
  );
}

async function heroItems(db: Executor, heroId: string): Promise<ItemInstance[]> {
  return db
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, heroId))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
}

/**
 * Whether `me` could send `them` an offer, with T.4's leak rules (the eligibility endpoint's): the
 * other account's standing is read only once the relation qualifies, and handed on as one bit.
 */
async function pairVerdict(
  db: Executor,
  me: { id: string; standing: TradeStanding },
  themId: string,
  settings: TradingSettings,
  now: Date,
) {
  const relation = await loadTradeRelation(db, me.id, themId);
  const probe = tradeDecision({
    action: 'send',
    settings,
    now,
    actor: me.standing,
    counterpart: null,
    relation,
  });
  let counterpart: 'hidden-eligible' | 'hidden-ineligible' | null = null;
  if (!probe.refusals.some((r) => r.party === 'pair')) {
    const theirs = await loadTradeStanding(db, themId, now);
    counterpart =
      theirs && standingRefusals(theirs, now).length === 0
        ? 'hidden-eligible'
        : 'hidden-ineligible';
  }
  const decision = tradeDecision({
    action: 'send',
    settings,
    now,
    actor: me.standing,
    counterpart,
    relation,
  });
  return {
    relation: tradeRelationKind(relation),
    allowed: decision.allowed,
    reasons: decision.refusals.map(reasonView),
    pairOk: !decision.refusals.some((r) => r.party === 'pair' || r.party === 'game'),
  };
}

/** What the receiver would be told if they accepted now (no locks; the accept checks again). */
async function previewAccept(
  db: Executor,
  offerId: string,
  me: string,
  settings: TradingSettings,
  now: Date,
): Promise<{ allowed: boolean; reasons: Record<string, unknown>[] }> {
  const [offer] = await db.select().from(tradeOffers).where(eq(tradeOffers.id, offerId));
  const lines = await loadLines(db, [offerId]);
  const ids = lines.filter((l) => l.kind === 'item').map((l) => l.itemId!);
  const rows = ids.length
    ? await db.select().from(itemInstances).where(inArray(itemInstances.id, ids))
    : [];
  const side = (s: 'give' | 'ask') => {
    const ls = lines.filter((l) => l.side === s);
    const materials: MaterialBundle = {};
    for (const l of ls) {
      if (l.kind === 'material' && isMaterialId(l.materialId ?? '')) {
        materials[l.materialId as MaterialId] = l.amount;
      }
    }
    return {
      items: ls
        .filter((l) => l.kind === 'item')
        .map((l) => rows.find((r) => r.id === l.itemId))
        .filter((r): r is ItemInstance => !!r)
        .map(itemFacts),
      gold: ls.filter((l) => l.kind === 'gold').reduce((n, l) => n + l.amount, 0),
      materials,
    };
  };
  const facts = { give: side('give'), ask: side('ask') };
  const standing = (await loadTradeStanding(db, me, now))!;
  const theirs = await loadTradeStanding(db, offer!.senderAccountId, now);
  const relation = await loadTradeRelation(db, me, offer!.senderAccountId);
  const decision = tradeDecision({
    action: 'accept',
    settings,
    now,
    actor: standing,
    counterpart: theirs,
    relation,
    offer: facts,
  });
  const reasons: Record<string, unknown>[] = decision.refusals.map(reasonView);
  if (rows.length < ids.length) {
    reasons.push({
      check: 'item_gone',
      party: 'offer',
      text: 'An item this offer asks for is no longer there.',
    });
  }
  for (const [accountId, role, party] of [
    [me, 'receiver', 'you'],
    [offer!.senderAccountId, 'sender', 'them'],
  ] as const) {
    const used = await readTradeCounters(db, accountId, now);
    for (const r of checkTradeCaps({
      used,
      adding: tradeCapIncrements(facts, role),
      limits: settings.limits,
      now,
    })) {
      reasons.push({ check: 'cap_reached', party, text: tradeCapText(r, party) });
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

export async function registerTradeOffers(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  // ----- The seams of T.2, T.4 and the social layer -----
  app.settingsEvents.onSettingsChanged(async (event, tx) => {
    await voidForSwitches(tx, event.switchedOff, event.actorAccountId, event.at, activity);
  });
  app.sanctionEvents.onSanctionIssued(async (event, tx) => {
    if (event.kind !== 'trade' && event.kind !== 'suspend') return;
    await voidForSanction(
      tx,
      event.subjectId,
      event.kind,
      event.actorAccountId,
      event.at,
      activity,
    );
  });
  app.relationEvents.onRelationEnded(async (event, tx) => {
    await voidForRelations(tx, event.accountIds, event.at, activity);
  });

  /** Writes the flag rows for unprovenanced items a refusal named (after the refusal). */
  async function flagRefused(err: unknown, accountId: string): Promise<never> {
    if (err instanceof TradeRefusedError && err.flagged.length > 0) {
      await withTransaction(app.db, async (tx) => {
        for (const itemId of err.flagged) {
          await writeAudit(tx, {
            event: 'trade.flag',
            accountId,
            data: { itemId, check: 'item_unprovenanced' },
          });
        }
      });
    }
    throw err;
  }

  const views = async (offers: Parameters<typeof offerViews>[1], me: string, now: Date) =>
    offerViews(app.db, offers, me, now);

  async function oneView(offerId: string, me: string, now: Date): Promise<TradeOfferView> {
    const o = await loadOwnOffer(app.db, offerId, me);
    return (await views([o], me, now))[0]!;
  }

  // ----- Reads -----
  app.get(
    '/trading/offers',
    {
      preHandler: app.requireAccount,
      schema: { response: { 200: inboxSchema, 304: { type: 'null' } } },
    },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const now = app.authNow();
      // Time first: this account's offers past 48 h expire, holds past 72 h are released.
      await sweepTrades(app.db, now, activity, { accountId: me, limit: 20 });
      const settings = await app.gameSettings.trading();
      const open = await openOffersOf(app.db, me);
      const recent = await endedOffersOf(app.db, me, { limit: RECENT });
      const all = await views([...open, ...recent], me, now);
      const openViews = all.slice(0, open.length);
      const body = {
        open: settings.trading,
        received: openViews.filter((o) => o.role === 'receiver'),
        sent: openViews.filter((o) => o.role === 'sender'),
        recent: all.slice(open.length),
        holds: await activeHoldsOf(app.db, me, now),
        pollMs: TRADE_INBOX_POLL_MS,
      };
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );

  app.get(
    '/trading/offers/history',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { before: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['offers', 'nextCursor'],
            properties: {
              offers: { type: 'array', items: offerSchema },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const me = request.auth!.account.id;
      const { before } = request.query as { before?: string };
      const rows = await endedOffersOf(app.db, me, { before, limit: HISTORY_PAGE + 1 });
      const page = rows.slice(0, HISTORY_PAGE);
      return {
        offers: await views(page, me, app.authNow()),
        nextCursor: rows.length > HISTORY_PAGE ? page[page.length - 1]!.id : null,
      };
    },
  );

  app.get<{ Params: { offerId: string } }>(
    '/trading/offers/:offerId',
    {
      preHandler: app.requireAccount,
      schema: { params: offerParams, response: { 200: detailSchema } },
    },
    async (request) => {
      const me = request.auth!.account.id;
      const now = app.authNow();
      const offer = await oneView(request.params.offerId, me, now);
      const decision =
        offer.status === 'open' && offer.role === 'receiver'
          ? await previewAccept(app.db, offer.id, me, await app.gameSettings.trading(), now)
          : null;
      return { offer, decision };
    },
  );

  app.get(
    '/trading/heroes',
    { preHandler: app.requireAccount, schema: { response: { 200: heroesSchema } } },
    async (request): Promise<{ heroes: TradeHeroOption[] }> => {
      const me = request.auth!.account.id;
      const now = app.authNow();
      const settings = await app.gameSettings.trading();
      const switches = tradingSwitchesOf(settings);
      const heroes = await app.db
        .select()
        .from(characters)
        .where(eq(characters.accountId, me))
        .orderBy(asc(characters.createdAt));
      const out: TradeHeroOption[] = [];
      for (const h of heroes) {
        const held = await heldValueOf(app.db, h.id, now);
        const stock = await loadMaterialBundle(app.db, h.id);
        out.push({
          id: h.id,
          name: h.name,
          classId: h.classId,
          level: h.level,
          gold: h.gold,
          heldGold: held.gold,
          materials: materialList(stock).map((m) => ({
            ...m,
            held: Math.min(m.quantity, held.materials[m.materialId] ?? 0),
          })),
          items: offerable(await heroItems(app.db, h.id), settings, now).map((i) =>
            itemView(i, switches),
          ),
        });
      }
      return { heroes: out };
    },
  );

  app.get(
    '/trading/partners',
    {
      preHandler: app.requireAccount,
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['partners'],
            properties: { partners: { type: 'array', items: partnerSchema } },
          },
        },
      },
    },
    async (request) => {
      const me = request.auth!.account;
      const now = app.authNow();
      const settings = await app.gameSettings.trading();
      const standing = (await loadTradeStanding(app.db, me.id, now))!;
      const ids = new Set(await friendIds(app.db, me.id));
      const [mine] = await app.db
        .select({ guildId: guildMembers.guildId })
        .from(guildMembers)
        .where(eq(guildMembers.accountId, me.id));
      if (mine) {
        const mates = await app.db
          .select({ id: guildMembers.accountId })
          .from(guildMembers)
          .where(eq(guildMembers.guildId, mine.guildId));
        for (const m of mates) if (m.id !== me.id) ids.add(m.id);
      }
      const partners = [];
      for (const id of ids) {
        const visible = visibleRelation(await relationBetween(app.db, me.id, id));
        if (!visible) continue;
        const v = await pairVerdict(app.db, { id: me.id, standing }, id, settings, now);
        if (v.relation === 'blocked') continue;
        partners.push({ id, ...v });
      }
      const people = await offerPeople(app.db, [...partners.map((p) => p.id)], now);
      return {
        partners: partners
          .map(({ id, relation, allowed, reasons }) => ({
            ...people.get(id)!,
            relation,
            allowed,
            reasons,
          }))
          .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '')),
      };
    },
  );

  app.get<{ Params: { handle: string } }>(
    '/trading/partners/:handle',
    {
      preHandler: app.requireAccount,
      schema: {
        params: {
          type: 'object',
          required: ['handle'],
          properties: { handle: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: { 200: partnerSchema },
      },
    },
    async (request) => {
      const me = request.auth!.account;
      const now = app.authNow();
      const them = await accountBy(app.db, { handle: request.params.handle }, now);
      const visible = them ? visibleRelation(await relationBetween(app.db, me.id, them.id)) : null;
      if (!them || !visible) throw new ApiError(404, 'not_found', 'No player by that name.');
      const settings = await app.gameSettings.trading();
      const standing = (await loadTradeStanding(app.db, me.id, now))!;
      const v = await pairVerdict(app.db, { id: me.id, standing }, them.id, settings, now);
      const person = (await offerPeople(app.db, [them.id], now)).get(them.id)!;
      // Their heroes and offerable items only once the pair may trade (relation, trading open).
      const heroes = [];
      if (v.pairOk) {
        const switches = tradingSwitchesOf(settings);
        const rows = await app.db
          .select()
          .from(characters)
          .where(eq(characters.accountId, them.id))
          .orderBy(asc(characters.createdAt));
        for (const h of rows) {
          heroes.push({
            id: h.id,
            name: h.name,
            classId: h.classId,
            level: h.level,
            items: offerable(await heroItems(app.db, h.id), settings, now).map((i) =>
              itemView(i, switches),
            ),
          });
        }
      }
      return { ...person, relation: v.relation, allowed: v.allowed, reasons: v.reasons, heroes };
    },
  );

  // ----- Writes -----
  app.post(
    '/trading/offers',
    {
      preHandler: app.requireAccount,
      schema: { body: sendBodySchema, response: { 201: offerSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as SendBody;
      const me = request.auth!.account.id;
      return tradeWrite(
        app,
        request,
        reply,
        async (tx, ctx) => {
          const them = await accountBy(tx, { handle: body.to }, ctx.now);
          // Unknown, or blocks you: the same not-found as anywhere else (T.4's leak rule).
          const visible = them ? visibleRelation(await relationBetween(tx, me, them.id)) : null;
          if (!them || !visible) throw new ApiError(404, 'not_found', 'No player by that name.');
          const id = await sendOffer(
            tx,
            {
              me: { id: me },
              standing: ctx.standing,
              settings: ctx.settings,
              now: ctx.now,
              receiver: { id: them.id },
              characterId: body.characterId,
              receiverCharacterId: body.receiverCharacterId,
              ...(body.give ? { give: body.give } : {}),
              ...(body.ask ? { ask: body.ask } : {}),
            },
            activity,
          );
          const o = await loadOwnOffer(tx, id, me);
          return (await offerViews(tx, [o], me, ctx.now))[0]!;
        },
        { idempotent: { status: 201 }, lockSettings: true },
      ).catch((e: unknown) => flagRefused(e, me));
    },
  );

  for (const action of ['cancel', 'decline'] as const) {
    app.post<{ Params: { offerId: string } }>(
      `/trading/offers/:offerId/${action}`,
      {
        preHandler: app.requireAccount,
        schema: { params: offerParams, response: { 200: offerSchema } },
      },
      async (request, reply) => {
        const me = request.auth!.account.id;
        return tradeWrite(
          app,
          request,
          reply,
          async (tx, ctx) => {
            await stepAway(
              tx,
              { me, offerId: request.params.offerId, action, now: ctx.now },
              activity,
            );
            const o = await loadOwnOffer(tx, request.params.offerId, me);
            return (await offerViews(tx, [o], me, ctx.now))[0]!;
          },
          { idempotent: {} },
        );
      },
    );
  }

  app.post<{ Params: { offerId: string }; Body: { characterId?: string } }>(
    '/trading/offers/:offerId/accept',
    {
      preHandler: app.requireAccount,
      schema: {
        params: offerParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { characterId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: offerSchema },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account.id;
      return tradeWrite(
        app,
        request,
        reply,
        async (tx, ctx) => {
          await acceptOffer(
            tx,
            {
              me: { id: me },
              standing: ctx.standing,
              settings: ctx.settings,
              now: ctx.now,
              offerId: request.params.offerId,
              characterId: request.body?.characterId,
            },
            activity,
          );
          const o = await loadOwnOffer(tx, request.params.offerId, me);
          return (await offerViews(tx, [o], me, ctx.now))[0]!;
        },
        { idempotent: {}, lockSettings: true },
      ).catch((e: unknown) => flagRefused(e, me));
    },
  );
}

/** Handles and display names (a name hidden by a moderator shows as null). */
async function offerPeople(db: Executor, ids: string[], now: Date) {
  const out = new Map<string, { handle: string; displayName: string | null }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: accounts.id, handle: accounts.handle, displayName: accounts.displayName })
    .from(accounts)
    .where(inArray(accounts.id, ids));
  const hidden = await hiddenTargetKeys(
    db,
    ids.map((id) => profileFieldKey(id, 'displayName')),
    now,
  );
  for (const r of rows) {
    out.set(r.id, {
      handle: r.handle,
      displayName: hidden.has(profileFieldKey(r.id, 'displayName')) ? null : r.displayName,
    });
  }
  return out;
}
