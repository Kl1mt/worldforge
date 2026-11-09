/**
 * Trade rules, eligibility and the trade restriction (ticket T.4, docs/TRADING.md "T.4 as
 * built"): your own standing; the permission matrix through the API (switches × relation and its
 * age × the other account's standing); what the eligibility endpoint may and may not say about
 * another player (enumeration and leaks); the trade-restriction sanction's lifecycle and seam;
 * the `trade` rate-limit class; and invariance (reading eligibility writes nothing, a trade
 * restriction blocks no social write).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_TRADING_SETTINGS, type TradingSettings } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  accounts,
  auditLog,
  blocks,
  friendships,
  gameSettings,
  reports,
  sanctions,
  tradeCounters,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertGuild } from '../test/guilds.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { pairOf } from '../social/relations.js';
import type { SanctionIssuedEvent } from '../social/sanctions.js';
import { tradeWrite } from './trade-write.js';

const DAY = 86_400_000;
const START = new Date();
let clock = START;
const ago = (days: number) => new Date(clock.getTime() - days * DAY);

let database: DatabaseHandle;
let app: FastifyInstance;
let call: ReturnType<typeof caller>;
let me: TestAccount;
let moderator: TestAccount;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: {
      now: () => clock,
      accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
      socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
    },
    testRoutes: (api) => {
      api.post('/test/trade-write', { preHandler: api.requireAccount }, (request, reply) =>
        tradeWrite(api, request, reply, async (_tx, ctx) => ({
          sanctions: ctx.standing.sanctions,
          trading: ctx.settings.trading,
        })),
      );
    },
  });
  await app.ready();
  call = caller(app);
  me = await eligible();
  moderator = await insertAccount(database.db, { role: 'moderator' });
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(async () => {
  clock = START;
  await closeTrading();
});

/** An account meeting every requirement unless told otherwise. */
async function eligible({
  ageDays = 30,
  level = 20,
  verified = true,
  sanction,
}: {
  ageDays?: number;
  level?: number;
  verified?: boolean;
  sanction?: 'mute' | 'suspend' | 'trade' | 'rename';
} = {}): Promise<TestAccount> {
  const a = await insertAccount(database.db, { now: START });
  await database.db
    .update(accounts)
    .set({ createdAt: ago(ageDays), emailVerifiedAt: verified ? ago(ageDays) : null })
    .where(eq(accounts.id, a.id));
  if (level > 0) await insertCharacter(database.db, a.id, { level });
  if (sanction) await sanctionOf(a, sanction);
  return a;
}

async function sanctionOf(a: TestAccount, kind: 'mute' | 'suspend' | 'trade' | 'rename') {
  await database.db.insert(sanctions).values({
    id: uuidv7(),
    subjectId: a.id,
    kind,
    reason: 'Test',
    createdAt: ago(1),
    expiresAt: new Date(clock.getTime() + 30 * DAY),
  });
}

async function befriend(a: TestAccount, b: TestAccount, daysAgo: number, status = 'friends') {
  const { low, high } = pairOf(a.id, b.id);
  await database.db.insert(friendships).values({
    accountLow: low,
    accountHigh: high,
    status: status as 'friends',
    requestedBy: a.id,
    createdAt: ago(daysAgo + 1),
    acceptedAt: status === 'friends' ? ago(daysAgo) : null,
  });
}

async function setTrading(over: (s: TradingSettings) => void) {
  const s = JSON.parse(JSON.stringify(DEFAULT_TRADING_SETTINGS)) as TradingSettings;
  over(s);
  await database.db.delete(gameSettings);
  await database.db.insert(gameSettings).values({
    key: 'trading',
    value: s as unknown as Record<string, unknown>,
    version: 1,
    updatedAt: clock,
  });
  app.gameSettings.invalidate();
}
async function closeTrading() {
  await database.db.delete(gameSettings);
  app.gameSettings.invalidate();
}

const eligibility = (who: TestAccount, handle?: string) =>
  call(
    who,
    'GET',
    `/api/trading/eligibility${handle ? `?handle=${encodeURIComponent(handle)}` : ''}`,
  );

describe('your own standing', () => {
  it('lists every requirement, met or not, with when the age is met', async () => {
    const fresh = await eligible({ ageDays: 3, level: 9, verified: false, sanction: 'trade' });
    const res = await eligibility(fresh);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trading).toEqual({
      open: false,
      kinds: { items: false, materials: false, gold: false },
    });
    expect(body.with).toBeNull();
    expect(body.you.eligible).toBe(false);
    const reqs = Object.fromEntries(
      body.you.requirements.map((r: { id: string }) => [r.id, r]),
    ) as Record<string, { met: boolean; metAt?: string; value?: number; sanctions?: string[] }>;
    expect(reqs.accountAge).toMatchObject({
      met: false,
      metAt: new Date(ago(3).getTime() + 14 * DAY).toISOString(),
    });
    expect(reqs.heroLevel).toMatchObject({ met: false, value: 9 });
    expect(reqs.email).toMatchObject({ met: false });
    expect(reqs.standing).toMatchObject({ met: false, sanctions: ['trade'] });

    const ok = await eligibility(me);
    expect(ok.json().you.eligible).toBe(true);
    expect(ok.json().you.requirements.every((r: { met: boolean }) => r.met)).toBe(true);
  });

  it('a forced rename or hidden content is not a trading sanction', async () => {
    const renamed = await eligible({ sanction: 'rename' });
    expect((await eligibility(renamed)).json().you.eligible).toBe(true);
  });

  it('shows your limits and this week’s usage from the settings', async () => {
    await setTrading((s) => {
      s.trading = true;
      s.trade.items = true;
      s.limits.goldPerWeek = 7_000;
    });
    const body = (await eligibility(me)).json();
    expect(body.trading.open).toBe(true);
    expect(body.usage.caps).toContainEqual({
      metric: 'gold',
      direction: 'received',
      period: 'week',
      used: 0,
      max: 7_000,
    });
    expect(body.usage.caps).toContainEqual({
      metric: 'trades',
      direction: 'any',
      period: 'day',
      used: 0,
      max: 5,
    });
    await closeTrading();
  });

  it('anonymous visitors get 401', async () => {
    expect((await call(null, 'GET', '/api/trading/eligibility')).statusCode).toBe(401);
  });
});

type Rel =
  | 'stranger'
  | 'pending'
  | 'friendNew'
  | 'friendOld'
  | 'guildmateNew'
  | 'guildmateOld'
  | 'blockedByMe'
  | 'blockedByThem';
type Standing =
  'eligible' | 'tooNew' | 'tooLow' | 'unverified' | 'muted' | 'suspended' | 'restricted';
const RELS: Rel[] = [
  'stranger',
  'pending',
  'friendNew',
  'friendOld',
  'guildmateNew',
  'guildmateOld',
  'blockedByMe',
  'blockedByThem',
];
const STANDINGS: Standing[] = [
  'eligible',
  'tooNew',
  'tooLow',
  'unverified',
  'muted',
  'suspended',
  'restricted',
];

/** The pair's refusal by relation (hand-written); `404` for a player who blocks you. */
const PAIR: Record<Rel, string | null | 404> = {
  stranger: 'no_relation',
  pending: 'no_relation',
  friendNew: 'relation_too_new',
  friendOld: null,
  guildmateNew: 'relation_too_new',
  guildmateOld: null,
  blockedByMe: 'blocked',
  blockedByThem: 404,
};
const RELATION_NAME: Record<Rel, string> = {
  stranger: 'none',
  pending: 'none',
  friendNew: 'friend',
  friendOld: 'friend',
  guildmateNew: 'guildmate',
  guildmateOld: 'guildmate',
  blockedByMe: 'blocked',
  blockedByThem: 'blocked',
};

async function counterpart(standing: Standing, rel: Rel, viewer: TestAccount) {
  const them = await eligible({
    ageDays: standing === 'tooNew' ? 5 : 30,
    level: standing === 'tooLow' ? 14 : 20,
    verified: standing !== 'unverified',
    ...(standing === 'muted'
      ? { sanction: 'mute' as const }
      : standing === 'suspended'
        ? { sanction: 'suspend' as const }
        : standing === 'restricted'
          ? { sanction: 'trade' as const }
          : {}),
  });
  if (rel === 'pending') await befriend(viewer, them, 0, 'pending');
  if (rel === 'friendNew') await befriend(viewer, them, 6);
  if (rel === 'friendOld') await befriend(viewer, them, 8);
  if (rel === 'guildmateNew' || rel === 'guildmateOld') {
    // A fresh viewer each time (one guild per account): see `viewerFor`.
    await insertGuild(database.db, viewer.id, {
      members: [{ accountId: them.id }],
      now: ago(rel === 'guildmateNew' ? 2 : 9),
    });
  }
  if (rel === 'blockedByMe')
    await database.db.insert(blocks).values({ blockerId: viewer.id, blockedId: them.id });
  if (rel === 'blockedByThem')
    await database.db.insert(blocks).values({ blockerId: them.id, blockedId: viewer.id });
  return them;
}

describe('the permission matrix through the API (switches × relation × their standing)', () => {
  for (const open of [false, true]) {
    for (const rel of RELS) {
      it(`${open ? 'open' : 'closed'} · ${rel} × every standing`, async () => {
        if (open) await setTrading((s) => (s.trading = true));
        else await closeTrading();
        const bodies: string[] = [];
        for (const standing of STANDINGS) {
          const viewer = await eligible();
          const them = await counterpart(standing, rel, viewer);
          const res = await eligibility(viewer, them.handle);
          const pair = PAIR[rel];
          if (pair === 404) {
            expect(res.statusCode).toBe(404);
            const unknown = await eligibility(viewer, 'zzzzzzzzzz');
            expect(res.body).toBe(unknown.body);
            continue;
          }
          expect(res.statusCode).toBe(200);
          const w = res.json().with;
          expect(Object.keys(w).sort()).toEqual(['allowed', 'handle', 'reasons', 'relation']);
          expect(w.handle).toBe(them.handle);
          expect(w.relation).toBe(RELATION_NAME[rel]);
          const expected = [
            ...(open ? [] : ['game:trading_off']),
            ...(pair ? [`pair:${pair}`] : []),
            // Their standing is told only once the relation qualifies, and only as one bit.
            ...(pair === null && standing !== 'eligible' ? ['them:them_not_eligible'] : []),
          ];
          expect(
            w.reasons.map((r: { party: string; check: string }) => `${r.party}:${r.check}`),
            standing,
          ).toEqual(expected);
          expect(w.allowed).toBe(expected.length === 0);
          for (const r of w.reasons) {
            if (r.party === 'them') {
              expect(r).toEqual({
                check: 'them_not_eligible',
                party: 'them',
                text: 'They can’t trade right now.',
              });
            }
          }
          // The body is the same whichever rule they miss (handle aside).
          if (standing !== 'eligible') bodies.push(JSON.stringify({ ...w, handle: '' }));
          // Without a qualifying relation even "eligible" reads the same as the rest.
          if (pair !== null && standing === 'eligible')
            bodies.push(JSON.stringify({ ...w, handle: '' }));
        }
        expect(new Set(bodies).size).toBeLessThanOrEqual(1);
      });
    }
  }

  it('yourself: you are told to use the shelf', async () => {
    const res = await eligibility(me, me.handle);
    expect(res.json().with).toMatchObject({ relation: 'self', allowed: false });
    expect(res.json().with.reasons.map((r: { check: string }) => r.check)).toEqual([
      'trading_off',
      'self',
    ]);
  });

  it('your own failing rules are listed with theirs hidden', async () => {
    await setTrading((s) => (s.trading = true));
    const viewer = await eligible({ level: 3 });
    const them = await counterpart('tooNew', 'friendOld', viewer);
    const reasons = (await eligibility(viewer, them.handle)).json().with.reasons;
    expect(reasons.map((r: { party: string; check: string }) => `${r.party}:${r.check}`)).toEqual([
      'you:hero_too_low',
      'them:them_not_eligible',
    ]);
    await closeTrading();
  });

  it('a relation too new says when it qualifies (a day both players know)', async () => {
    const viewer = await eligible();
    const them = await counterpart('eligible', 'friendNew', viewer);
    const r = (await eligibility(viewer, them.handle)).json().with.reasons[1];
    expect(r).toMatchObject({
      check: 'relation_too_new',
      metAt: new Date(ago(6).getTime() + 7 * DAY).toISOString(),
    });
  });

  it('a friendship counts once it is 7 days old, on the injected clock', async () => {
    await setTrading((s) => (s.trading = true));
    const viewer = await eligible();
    const them = await counterpart('eligible', 'friendNew', viewer);
    expect((await eligibility(viewer, them.handle)).json().with.allowed).toBe(false);
    clock = new Date(START.getTime() + DAY);
    expect((await eligibility(viewer, them.handle)).json().with.allowed).toBe(true);
    await closeTrading();
  });

  it('enumeration: malformed, unknown and blocking handles look the same', async () => {
    const blocker = await counterpart('eligible', 'blockedByThem', me);
    const a = await eligibility(me, 'no-such-player-here');
    const b = await eligibility(me, blocker.handle);
    expect(a.statusCode).toBe(404);
    expect(b.body).toBe(a.body);
    // A bad query is a validation error before any lookup.
    expect((await call(me, 'GET', '/api/trading/eligibility?handle=')).statusCode).toBe(400);
    expect((await call(me, 'GET', '/api/trading/eligibility?other=1')).statusCode).toBe(400);
  });
});

describe('the trade-restriction sanction (4.1 queue)', () => {
  async function reportOf(subject: TestAccount): Promise<string> {
    const reporter = await insertAccount(database.db);
    const res = await call(reporter, 'POST', '/api/reports', {
      target: { kind: 'player', handle: subject.handle },
      reason: 'other',
    });
    expect(res.statusCode).toBe(201);
    return res.json().report.id;
  }

  it('issue → trading off, play and social writes go on → lift → back', async () => {
    const subject = await eligible();
    const reportId = await reportOf(subject);
    const res = await call(moderator, 'POST', `/api/mod/reports/${reportId}/resolve`, {
      action: 'restrictTrade',
      reason: 'Selling gold outside the game.',
      durationHours: 24 * 7,
    });
    expect(res.statusCode).toBe(200);
    const sanction = res.json().sanction;
    expect(sanction).toMatchObject({ kind: 'trade', reason: 'Selling gold outside the game.' });
    expect(new Date(sanction.expiresAt).getTime() - clock.getTime()).toBe(7 * DAY);

    const [issued] = await database.db
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.event} = 'sanction.issue' and ${auditLog.data}->>'sanctionId' = ${sanction.id}`,
      );
    expect(issued).toMatchObject({
      accountId: subject.id,
      data: { kind: 'trade', issuedBy: moderator.id },
    });

    // The player sees it, and only trading is off.
    const standing = (await call(subject, 'GET', '/api/account/standing')).json();
    expect(standing.sanctions.map((s: { kind: string }) => s.kind)).toEqual(['trade']);
    expect((await eligibility(subject)).json().you.requirements[3]).toMatchObject({
      met: false,
      sanctions: ['trade'],
    });
    expect(
      (await call(subject, 'POST', '/api/account/presence', { hidden: true })).statusCode,
    ).toBe(200);
    expect((await call(subject, 'GET', '/api/characters')).statusCode).toBe(200);

    // One at a time.
    const again = await call(
      moderator,
      'POST',
      `/api/mod/reports/${await reportOf(subject)}/resolve`,
      {
        action: 'restrictTrade',
        reason: 'Again.',
        durationHours: 24,
      },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_sanctioned');

    const lift = await call(moderator, 'POST', `/api/mod/sanctions/${sanction.id}/lift`, {
      reason: 'Appeal accepted.',
    });
    expect(lift.statusCode).toBe(200);
    expect((await eligibility(subject)).json().you.eligible).toBe(true);
    const [lifted] = await database.db
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.event} = 'sanction.lift' and ${auditLog.data}->>'sanctionId' = ${sanction.id}`,
      );
    expect(lifted).toMatchObject({
      data: { kind: 'trade', liftedBy: moderator.id, reason: 'Appeal accepted.' },
    });
  });

  it('it ends by itself at its expiry', async () => {
    const subject = await eligible();
    const res = await call(
      moderator,
      'POST',
      `/api/mod/reports/${await reportOf(subject)}/resolve`,
      {
        action: 'restrictTrade',
        reason: 'Cooling off.',
        durationHours: 1,
      },
    );
    expect(res.statusCode).toBe(200);
    expect((await eligibility(subject)).json().you.eligible).toBe(false);
    clock = new Date(START.getTime() + 3_600_000);
    expect((await eligibility(subject)).json().you.eligible).toBe(true);
  });

  it('durations follow SANCTION_DURATIONS; players never reach the route', async () => {
    const subject = await eligible();
    const reportId = await reportOf(subject);
    const tooLong = await call(moderator, 'POST', `/api/mod/reports/${reportId}/resolve`, {
      action: 'restrictTrade',
      reason: 'x',
      durationHours: 24 * 366,
    });
    expect(tooLong.statusCode).toBe(400);
    const player = await insertAccount(database.db);
    const hidden = await call(player, 'POST', `/api/mod/reports/${reportId}/resolve`, {
      action: 'restrictTrade',
      reason: 'x',
      durationHours: 24,
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('the seam runs inside the issuing transaction; a throw refuses the sanction', async () => {
    const seen: SanctionIssuedEvent[] = [];
    let rowsSeen = -1;
    const off = app.sanctionEvents.onSanctionIssued(async (event, tx) => {
      seen.push(event);
      const rows = await tx.select().from(sanctions).where(eq(sanctions.id, event.sanction.id));
      rowsSeen = rows.length;
    });
    const subject = await eligible();
    await call(moderator, 'POST', `/api/mod/reports/${await reportOf(subject)}/resolve`, {
      action: 'restrictTrade',
      reason: 'Seam.',
      durationHours: 24,
    });
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'trade',
      subjectId: subject.id,
      actorAccountId: moderator.id,
    });
    expect(rowsSeen).toBe(1);

    const offThrow = app.sanctionEvents.onSanctionIssued(async () => {
      throw new Error('refuse');
    });
    const other = await eligible();
    const reportId = await reportOf(other);
    const res = await call(moderator, 'POST', `/api/mod/reports/${reportId}/resolve`, {
      action: 'restrictTrade',
      reason: 'Seam.',
      durationHours: 24,
    });
    offThrow();
    expect(res.statusCode).toBe(500);
    expect(
      await database.db.select().from(sanctions).where(eq(sanctions.subjectId, other.id)),
    ).toEqual([]);
    const [report] = await database.db.select().from(reports).where(eq(reports.id, reportId));
    expect(report!.status).toBe('open');
  });
});

describe('the trade rate-limit class', () => {
  it('20 trade writes a minute, then 429 with details.limit trade; the social class is apart', async () => {
    const a = await eligible({ sanction: 'trade' });
    for (let i = 0; i < 20; i++) {
      const r = await call(a, 'POST', '/api/test/trade-write');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ sanctions: ['trade'], trading: false });
    }
    const over = await call(a, 'POST', '/api/test/trade-write');
    expect(over.statusCode).toBe(429);
    expect(over.json().error.details).toMatchObject({ limit: 'trade' });
    expect(over.headers['retry-after']).toBeDefined();
    expect((await call(a, 'POST', '/api/account/presence', { hidden: false })).statusCode).toBe(
      200,
    );
    clock = new Date(START.getTime() + 60_000);
    expect((await call(a, 'POST', '/api/test/trade-write')).statusCode).toBe(200);
  });
});

describe('invariance', () => {
  it('reading eligibility writes nothing', async () => {
    const before = await database.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    const viewer = await eligible();
    const them = await counterpart('eligible', 'friendOld', viewer);
    const afterSetup = await database.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    for (let i = 0; i < 3; i++) await eligibility(viewer, them.handle);
    await eligibility(viewer);
    const after = await database.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    expect(after[0]!.n).toBe(afterSetup[0]!.n);
    expect(before[0]!.n).toBeLessThanOrEqual(afterSetup[0]!.n);
    expect(await database.db.select().from(tradeCounters)).toEqual([]);
  });
});
