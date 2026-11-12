import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  GUILD_HALL_KINDS,
  GUILD_HALL_REFUSALS,
  GUILD_HALL_UPGRADES,
  GUILD_SEASON_RULES,
  TREASURY_NO_REFUND_NOTICE,
  TREASURY_RESOURCES,
  canAfford,
  contributionWindow,
  findGuildHallUpgrade,
  guildHallDecision,
  hallDisplayProblem,
  isTreasuryResource,
  planTreasuryGift,
  treasuryCap,
  treasuryRoom,
  type GuildHallAction,
  type GuildHallKind,
  type GuildRefusal,
  type GuildStanding,
  type MaterialId,
  type TreasuryAmounts,
  type TreasuryMaterial,
  type TreasuryResource,
} from '@worldforge/game-core';
import {
  accounts,
  guildHallDisplays,
  guildHallUpgrades,
  guildMembers,
  guildSeasonAwards,
  type Guild,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterSchema, characterView } from '../characters/routes.js';
import { changeGold } from '../economy/shared.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { lockOwnedCharacter } from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { recordTelemetry } from '../telemetry/record.js';
import { goldOut, materialCounts } from '../telemetry/counts.js';
import { assertSocialWriteAllowed } from '../social/social-write.js';
import { lockGuild, membershipOf } from '../social/guild-model.js';
import { visibleGuild } from '../social/guilds.js';
import {
  addGift,
  givenToday,
  hallDisplayOf,
  ownedUpgrades,
  plainHall,
  treasuryAmounts,
  treasuryOf,
  writeTreasury,
} from './model.js';
import { guildStandingOf } from '../guild-seasons/routes.js';
import { refreshGuildSeason } from '../guild-seasons/model.js';

/**
 * Guild hall routes (ticket 8.4, docs/GUILD_HALLS.md, docs/API_CONVENTIONS.md "Guild halls").
 *
 * - `GET /api/guild/hall`: the hall of the viewer's guild: treasury, caps, upgrades, look, the
 *   guild's standing on the season roll and its honours.
 * - `POST /api/guild/hall/contribute`: a value operation (`Idempotency-Key`), a social write
 *   (`guildTreasury`, mute-exempt). Lock order: account (share) → hero (settles first) → guild lock
 *   → treasury row. The body must carry `acknowledgeNoRefund: true` (the notice is shown first).
 * - `POST /api/guild/hall/buy`, `POST /api/guild/hall/display`: leader or officer
 *   (`guildHallDecision`), under the guild lock.
 * - `GET /api/guilds/:handle/hall`: any guild's look and honours, as public as its profile.
 */

function refuse(r: GuildRefusal, details?: Record<string, unknown>): never {
  throw new ApiError(r.status, r.code, r.message, details);
}

function decide(standing: GuildStanding, action: GuildHallAction) {
  const d = guildHallDecision(standing, action);
  if (d !== 'allowed') refuse(d);
}

/** Inside a transaction: the actor's guild under its lock, re-read after the lock. */
async function lockedMembership(tx: Transaction, accountId: string) {
  const first = await membershipOf(tx, accountId);
  if (!first) return null;
  await lockGuild(tx, first.guild.id);
  const mine = await membershipOf(tx, accountId);
  return mine && mine.guild.id === first.guild.id ? mine : null;
}

/** D.4: a test account touches only a guild of test accounts' treasury (read under the lock). */
async function refuseTestAccountInRealGuild(tx: Executor, accountId: string, guildId: string) {
  const [self] = await tx
    .select({ isTest: accounts.isTest })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!self?.isTest) return;
  const [real] = await tx
    .select({ accountId: guildMembers.accountId })
    .from(guildMembers)
    .innerJoin(accounts, eq(accounts.id, guildMembers.accountId))
    .where(and(eq(guildMembers.guildId, guildId), eq(accounts.isTest, false)))
    .limit(1);
  if (real) {
    throw new ApiError(
      403,
      'test_account',
      'Test accounts use the treasury only in a guild of test accounts.',
    );
  }
}

const amountList = (a: TreasuryAmounts) =>
  TREASURY_RESOURCES.filter((r) => (a[r] ?? 0) > 0).map((r) => ({ resource: r, amount: a[r]! }));

const lookSchema = {
  type: 'object',
  required: [...GUILD_HALL_KINDS],
  properties: Object.fromEntries(GUILD_HALL_KINDS.map((k) => [k, { type: ['string', 'null'] }])),
} as const;

export const guildLookSchema = lookSchema;

export interface HallView {
  guild: { handle: string; name: string; tag: string; emblem: string; role: string };
  treasury: { gold: number; materials: Partial<Record<TreasuryMaterial, number>> };
  window: { day: string; resetsAt: string };
  resources: { resource: TreasuryResource; cap: number; givenToday: number; room: number }[];
  upgrades: {
    id: string;
    kind: GuildHallKind;
    name: string;
    description: string;
    price: { gold: number; materials: Partial<Record<TreasuryMaterial, number>> };
    owned: boolean;
    boughtOn: string | null;
    affordable: boolean;
  }[];
  look: Record<GuildHallKind, string | null>;
  can: { contribute: boolean; buy: boolean; display: boolean };
  notice: string;
  honours: { season: number; tier: string; rank: number }[];
  standing: Awaited<ReturnType<typeof guildStandingOf>>;
  me: { joinedAt: string; countsFrom: string; honourBy: string | null };
  rules: { countAfterDays: number; honourAfterDays: number; minMembers: number };
}

export async function honoursOf(executor: Executor, guildId: string) {
  const rows = await executor
    .select({
      season: guildSeasonAwards.season,
      tier: guildSeasonAwards.tier,
      rank: guildSeasonAwards.rank,
    })
    .from(guildSeasonAwards)
    .where(eq(guildSeasonAwards.guildId, guildId))
    .orderBy(sql`${guildSeasonAwards.season} desc`);
  return rows;
}

async function hallView(
  executor: Executor,
  accountId: string,
  guild: Guild,
  role: GuildStanding,
  joinedAt: Date,
  now: Date,
): Promise<HallView> {
  const treasury = await treasuryOf(executor, guild.id);
  const bought = await ownedUpgrades(executor, guild.id);
  const owned = new Set(bought.map((b) => b.upgradeId));
  const { day, endsAt } = contributionWindow(now);
  const given = await givenToday(executor, guild.id, accountId, day);
  const room = treasuryRoom(owned, treasuryAmounts(treasury));
  const held = treasuryAmounts(treasury);
  const look = (await hallDisplayOf(executor, [guild.id])).get(guild.id) ?? plainHall();
  const standing = await guildStandingOf(executor, guild.id, now);
  const DAY = 86_400_000;
  const honourBy = standing.season
    ? new Date(
        Date.parse(standing.season.endsAt) - GUILD_SEASON_RULES.honourAfterDays * DAY,
      ).toISOString()
    : null;
  return {
    guild: { handle: guild.handle, name: guild.name, tag: guild.tag, emblem: guild.emblem, role },
    treasury,
    window: { day, resetsAt: endsAt.toISOString() },
    resources: TREASURY_RESOURCES.map((r) => ({
      resource: r,
      cap: treasuryCap(r),
      givenToday: given[r] ?? 0,
      room: room[r],
    })),
    upgrades: GUILD_HALL_UPGRADES.map((u) => {
      const b = bought.find((x) => x.upgradeId === u.id);
      return {
        id: u.id,
        kind: u.kind,
        name: u.name,
        description: u.description,
        price: u.price,
        owned: !!b,
        boughtOn: b ? b.boughtAt.toISOString().slice(0, 10) : null,
        affordable: !b && canAfford(u, held),
      };
    }),
    look,
    can: {
      contribute: guildHallDecision(role, 'contribute') === 'allowed',
      buy: guildHallDecision(role, 'buy') === 'allowed',
      display: guildHallDecision(role, 'display') === 'allowed',
    },
    notice: TREASURY_NO_REFUND_NOTICE,
    honours: await honoursOf(executor, guild.id),
    standing,
    me: {
      joinedAt: joinedAt.toISOString(),
      countsFrom: new Date(
        joinedAt.getTime() + GUILD_SEASON_RULES.countAfterDays * DAY,
      ).toISOString(),
      honourBy,
    },
    rules: { ...GUILD_SEASON_RULES },
  };
}

const anyObject = { type: 'object', additionalProperties: true } as const;

export async function registerGuildHalls(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  const view = async (accountId: string) => {
    const mine = await membershipOf(app.db, accountId);
    const standing: GuildStanding = mine ? mine.member.role : 'none';
    decide(standing, 'view');
    // The guild's own roll entry is brought up to date first (like the board's viewer refresh).
    await refreshGuildSeason(app.db, activity.now(), app.authNow(), [mine!.guild.id]);
    return hallView(
      app.db,
      accountId,
      mine!.guild,
      standing,
      mine!.member.joinedAt,
      activity.now(),
    );
  };

  app.get('/guild/hall', { preHandler: app.requireAccount }, async (request) => {
    const me = request.auth!.account.id;
    return view(me);
  });

  app.get<{ Params: { handle: string } }>(
    '/guilds/:handle/hall',
    { preHandler: app.requireAccount },
    async (request) => {
      const guild = await visibleGuild(app.db, request.auth!.account.id, request.params.handle);
      if (!guild) throw new ApiError(404, 'not_found', 'No such guild.');
      return {
        look: (await hallDisplayOf(app.db, [guild.id])).get(guild.id) ?? plainHall(),
        honours: await honoursOf(app.db, guild.id),
      };
    },
  );

  app.post(
    '/guild/hall/contribute',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['characterId', 'offer', 'acknowledgeNoRefund'],
          properties: {
            characterId: { type: 'string', format: 'uuid' },
            acknowledgeNoRefund: { type: 'boolean' },
            offer: {
              type: 'array',
              minItems: 1,
              maxItems: TREASURY_RESOURCES.length,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['resource', 'amount'],
                properties: {
                  resource: { type: 'string', enum: [...TREASURY_RESOURCES] },
                  amount: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['accepted', 'limited', 'character', 'hall'],
            properties: {
              accepted: { type: 'array', items: anyObject },
              limited: anyObject,
              character: characterSchema,
              hall: anyObject,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const body = request.body as {
        characterId: string;
        acknowledgeNoRefund: boolean;
        offer: { resource: TreasuryResource; amount: number }[];
      };
      if (body.acknowledgeNoRefund !== true) refuse(GUILD_HALL_REFUSALS.noRefundUnacknowledged);
      const offer: TreasuryAmounts = {};
      for (const o of body.offer) {
        if (!isTreasuryResource(o.resource) || offer[o.resource] !== undefined) {
          throw new ApiError(400, 'validation_failed', 'Each resource may appear once.', {
            fields: { offer: `${o.resource} appears twice.` },
          });
        }
        offer[o.resource] = o.amount;
      }
      await app.socialWriteLimit(me, reply);
      return idempotentTransaction(app, request, reply, { now: activity.now }, async (tx) => {
        const now = activity.now();
        await assertSocialWriteAllowed(tx, me, 'guildTreasury', app.authNow());
        const hero = await lockOwnedCharacter(tx, me, body.characterId, activity);
        const mine = await lockedMembership(tx, me);
        decide(mine ? mine.member.role : 'none', 'contribute');
        const guild = mine!.guild;
        await refuseTestAccountInRealGuild(tx, me, guild.id);
        const held = await loadMaterialBundle(tx, hero.id);
        if ((offer.gold ?? 0) > hero.gold) {
          throw new ApiError(422, 'insufficient_gold', 'Not enough gold.', {
            required: offer.gold,
            held: hero.gold,
          });
        }
        for (const [r, n] of Object.entries(offer) as [TreasuryResource, number][]) {
          if (r !== 'gold' && n > (held[r] ?? 0)) {
            throw new ApiError(422, 'insufficient_materials', 'Not enough materials.', {
              resource: r,
              required: n,
              held: held[r] ?? 0,
            });
          }
        }
        const treasury = await treasuryOf(tx, guild.id, { forUpdate: true });
        const owned = new Set((await ownedUpgrades(tx, guild.id)).map((u) => u.upgradeId));
        const { day, endsAt } = contributionWindow(now);
        const plan = planTreasuryGift(
          owned,
          treasuryAmounts(treasury),
          await givenToday(tx, guild.id, me, day),
          offer,
        );
        if (Object.keys(plan.accepted).length === 0) {
          refuse(GUILD_HALL_REFUSALS.nothingTaken, {
            resetsAt: endsAt.toISOString(),
            limited: plan.limited,
          });
        }
        const gold = plan.accepted.gold ?? 0;
        const materials: Partial<Record<TreasuryMaterial, number>> = {};
        for (const [r, n] of Object.entries(plan.accepted) as [TreasuryResource, number][]) {
          if (r !== 'gold') materials[r] = n;
        }
        let character = hero;
        if (gold > 0) character = await changeGold(tx, hero, -gold, now);
        await changeMaterialsTx(
          tx,
          hero.id,
          Object.fromEntries(
            Object.entries(materials).map(([k, n]) => [k as MaterialId, -n]),
          ) as Partial<Record<MaterialId, number>>,
          now,
        );
        const next = { gold: treasury.gold + gold, materials: { ...treasury.materials } };
        for (const [m, n] of Object.entries(materials) as [TreasuryMaterial, number][]) {
          next.materials[m] = (next.materials[m] ?? 0) + n;
        }
        await writeTreasury(tx, guild.id, next, now);
        await addGift(tx, guild.id, me, day, plan.accepted);
        await writeAudit(tx, {
          event: 'guild.treasury_contribute',
          accountId: me,
          characterId: hero.id,
          data: {
            guildId: guild.id,
            day,
            gold,
            materials,
            goldAfter: character.gold,
            treasuryGold: next.gold,
          },
        });
        recordTelemetry(tx, now, [
          { metric: 'guild_treasury.contribute', amount: gold },
          ...goldOut('guild_treasury', '', gold),
          ...materialCounts('material.out', 'guild_treasury', materials),
        ]);
        return {
          accepted: amountList(plan.accepted),
          limited: plan.limited,
          character: characterView(character),
          hall: await hallView(tx, me, guild, mine!.member.role, mine!.member.joinedAt, now),
        };
      });
    },
  );

  app.post(
    '/guild/hall/buy',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['upgradeId'],
          properties: { upgradeId: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const { upgradeId } = request.body as { upgradeId: string };
      await app.socialWriteLimit(me, reply);
      return idempotentTransaction(app, request, reply, { now: activity.now }, async (tx) => {
        const now = activity.now();
        await assertSocialWriteAllowed(tx, me, 'guildHallBuy', app.authNow());
        const mine = await lockedMembership(tx, me);
        decide(mine ? mine.member.role : 'none', 'buy');
        const guild = mine!.guild;
        await refuseTestAccountInRealGuild(tx, me, guild.id);
        const u = findGuildHallUpgrade(upgradeId);
        if (!u) refuse(GUILD_HALL_REFUSALS.unknown);
        const owned = new Set((await ownedUpgrades(tx, guild.id)).map((x) => x.upgradeId));
        if (owned.has(u.id)) refuse(GUILD_HALL_REFUSALS.alreadyOwned);
        const treasury = await treasuryOf(tx, guild.id, { forUpdate: true });
        if (!canAfford(u, treasuryAmounts(treasury))) refuse(GUILD_HALL_REFUSALS.cannotAfford);
        const next = { gold: treasury.gold - u.price.gold, materials: { ...treasury.materials } };
        for (const [m, n] of Object.entries(u.price.materials) as [TreasuryMaterial, number][]) {
          next.materials[m] = (next.materials[m] ?? 0) - n;
        }
        await writeTreasury(tx, guild.id, next, now);
        await tx.insert(guildHallUpgrades).values({
          guildId: guild.id,
          upgradeId: u.id,
          boughtBy: me,
          gold: u.price.gold,
          materials: u.price.materials,
          boughtAt: now,
        });
        await writeAudit(tx, {
          event: 'guild.hall_buy',
          accountId: me,
          data: {
            guildId: guild.id,
            upgradeId: u.id,
            kind: u.kind,
            gold: u.price.gold,
            materials: u.price.materials,
            treasuryGold: next.gold,
          },
        });
        recordTelemetry(tx, now, [
          { metric: 'guild_hall.buy', dims: [u.kind, u.id], amount: u.price.gold },
        ]);
        return hallView(tx, me, guild, mine!.member.role, mine!.member.joinedAt, now);
      });
    },
  );

  app.post(
    '/guild/hall/display',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: Object.fromEntries(
            GUILD_HALL_KINDS.map((k) => [k, { type: ['string', 'null'], maxLength: 64 }]),
          ),
        },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account.id;
      const body = request.body as Partial<Record<GuildHallKind, string | null>>;
      await app.socialWriteLimit(me, reply);
      return idempotentTransaction(app, request, reply, { now: activity.now }, async (tx) => {
        const now = activity.now();
        await assertSocialWriteAllowed(tx, me, 'guildHallDisplay', app.authNow());
        const mine = await lockedMembership(tx, me);
        decide(mine ? mine.member.role : 'none', 'display');
        const guild = mine!.guild;
        const owned = new Set((await ownedUpgrades(tx, guild.id)).map((x) => x.upgradeId));
        for (const k of GUILD_HALL_KINDS) {
          if (!(k in body)) continue;
          const problem = hallDisplayProblem(k, body[k] ?? null, owned);
          if (problem === 'unknown') refuse(GUILD_HALL_REFUSALS.unknown, { kind: k });
          if (problem === 'wrong_kind') refuse(GUILD_HALL_REFUSALS.wrongKind, { kind: k });
          if (problem === 'not_owned') refuse(GUILD_HALL_REFUSALS.notOwned, { kind: k });
        }
        const before = (await hallDisplayOf(tx, [guild.id])).get(guild.id) ?? plainHall();
        const after = { ...before };
        for (const k of GUILD_HALL_KINDS) if (k in body) after[k] = body[k] ?? null;
        await tx
          .insert(guildHallDisplays)
          .values({ guildId: guild.id, ...after, updatedAt: now })
          .onConflictDoUpdate({
            target: guildHallDisplays.guildId,
            set: { ...after, updatedAt: now },
          });
        await writeAudit(tx, {
          event: 'guild.hall_display',
          accountId: me,
          data: { guildId: guild.id, before, after },
        });
        return hallView(tx, me, guild, mine!.member.role, mine!.member.joinedAt, now);
      });
    },
  );
}
