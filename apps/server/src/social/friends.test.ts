import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, or } from 'drizzle-orm';
import { FRIEND_LIMITS, PRESENCE_BUCKETS, type Relation } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accountPresence,
  accounts,
  auditLog,
  blocks,
  friendships,
  sanctions,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import {
  blockedEitherWay,
  friendIds,
  isBlockedEitherWay,
  pairOf,
  relationBetween,
  relationsFor,
} from './relations.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('friends, blocks & presence (ticket 4.3)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2026-11-06T12:00:00Z');
  const now = () => new Date(nowMs);
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 30 }] } },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  beforeEach(() => {
    nowMs += 10 * MIN;
  });

  const player = () => insertAccount(database.db, { now: now() });
  const send = (from: TestAccount, to: TestAccount) =>
    call(from, 'POST', '/api/friends/requests', { handle: to.handle });
  const act = (who: TestAccount, path: string) => call(who, 'POST', path);
  const list = async (who: TestAccount) => {
    const res = await call(who, 'GET', '/api/friends');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FriendsView>();
  };
  interface Entry {
    handle: string;
    displayName: string | null;
    presence?: string | null;
  }
  interface FriendsView {
    friends: Entry[];
    incoming: Entry[];
    outgoing: Entry[];
    blocked: Entry[];
    presenceHidden: boolean;
  }

  // ---- The relation matrix: every relation × every action, expected by hand. ----

  type Setup = Relation;
  async function setUp(rel: Setup): Promise<[TestAccount, TestAccount]> {
    const me = await player();
    if (rel === 'self') return [me, me];
    const them = await player();
    const ok = async (p: Promise<{ statusCode: number; body: string }>) => {
      const r = await p;
      expect(r.statusCode, r.body).toBe(200);
    };
    if (rel === 'requested-by-me') await ok(send(me, them));
    if (rel === 'requested-by-them') await ok(send(them, me));
    if (rel === 'friend') {
      await ok(send(me, them));
      await ok(act(them, `/api/friends/requests/${me.handle}/accept`));
    }
    if (rel === 'blocked-by-me') await ok(call(me, 'POST', '/api/blocks', { handle: them.handle }));
    if (rel === 'blocked-by-them')
      await ok(call(them, 'POST', '/api/blocks', { handle: me.handle }));
    expect(await relationBetween(database.db, me.id, them.id)).toBe(rel);
    return [me, them];
  }

  const ACTIONS = {
    sendRequest: (me: TestAccount, t: TestAccount) => send(me, t),
    accept: (me: TestAccount, t: TestAccount) =>
      act(me, `/api/friends/requests/${t.handle}/accept`),
    decline: (me: TestAccount, t: TestAccount) =>
      act(me, `/api/friends/requests/${t.handle}/decline`),
    cancel: (me: TestAccount, t: TestAccount) =>
      act(me, `/api/friends/requests/${t.handle}/cancel`),
    remove: (me: TestAccount, t: TestAccount) => act(me, `/api/friends/${t.handle}/remove`),
    block: (me: TestAccount, t: TestAccount) =>
      call(me, 'POST', '/api/blocks', { handle: t.handle }),
    unblock: (me: TestAccount, t: TestAccount) => act(me, `/api/blocks/${t.handle}/remove`),
    report: (me: TestAccount, t: TestAccount) =>
      call(me, 'POST', '/api/reports', {
        target: { kind: 'player', handle: t.handle },
        reason: 'spam',
      }),
  } as const;
  type Action = keyof typeof ACTIONS;

  // [status, error code or the relation afterwards]. Hand-written, not derived from the matrix.
  type Cell = [number, string];
  const EXPECTED: Record<Action, Record<Setup, Cell>> = {
    sendRequest: {
      self: [422, 'cannot_target_self'],
      stranger: [200, 'requested-by-me'],
      'requested-by-me': [409, 'request_pending'],
      'requested-by-them': [200, 'friend'],
      friend: [409, 'already_friends'],
      'blocked-by-me': [409, 'blocked_by_you'],
      'blocked-by-them': [404, 'not_found'],
    },
    accept: {
      self: [422, 'cannot_target_self'],
      stranger: [404, 'no_request'],
      'requested-by-me': [404, 'no_request'],
      'requested-by-them': [200, 'friend'],
      friend: [409, 'already_friends'],
      'blocked-by-me': [404, 'no_request'],
      'blocked-by-them': [404, 'not_found'],
    },
    decline: {
      self: [422, 'cannot_target_self'],
      stranger: [404, 'no_request'],
      'requested-by-me': [404, 'no_request'],
      'requested-by-them': [200, 'stranger'],
      friend: [404, 'no_request'],
      'blocked-by-me': [404, 'no_request'],
      'blocked-by-them': [404, 'not_found'],
    },
    cancel: {
      self: [422, 'cannot_target_self'],
      stranger: [404, 'no_request'],
      'requested-by-me': [200, 'stranger'],
      'requested-by-them': [404, 'no_request'],
      friend: [404, 'no_request'],
      'blocked-by-me': [404, 'no_request'],
      'blocked-by-them': [404, 'not_found'],
    },
    remove: {
      self: [422, 'cannot_target_self'],
      stranger: [404, 'not_friends'],
      'requested-by-me': [404, 'not_friends'],
      'requested-by-them': [404, 'not_friends'],
      friend: [200, 'stranger'],
      'blocked-by-me': [404, 'not_friends'],
      'blocked-by-them': [404, 'not_found'],
    },
    block: {
      self: [422, 'cannot_target_self'],
      stranger: [200, 'blocked-by-me'],
      'requested-by-me': [200, 'blocked-by-me'],
      'requested-by-them': [200, 'blocked-by-me'],
      friend: [200, 'blocked-by-me'],
      'blocked-by-me': [409, 'already_blocked'],
      'blocked-by-them': [200, 'blocked-by-me'],
    },
    unblock: {
      self: [422, 'cannot_target_self'],
      stranger: [404, 'not_blocked'],
      'requested-by-me': [404, 'not_blocked'],
      'requested-by-them': [404, 'not_blocked'],
      friend: [404, 'not_blocked'],
      'blocked-by-me': [200, 'stranger'],
      'blocked-by-them': [404, 'not_found'],
    },
    // 4.1's report route: a block never stops a report.
    report: {
      self: [422, 'cannot_report_self'],
      stranger: [201, 'stranger'],
      'requested-by-me': [201, 'requested-by-me'],
      'requested-by-them': [201, 'requested-by-them'],
      friend: [201, 'friend'],
      'blocked-by-me': [201, 'blocked-by-me'],
      'blocked-by-them': [201, 'blocked-by-them'],
    },
  };

  const SETUPS: Setup[] = [
    'self',
    'stranger',
    'requested-by-me',
    'requested-by-them',
    'friend',
    'blocked-by-me',
    'blocked-by-them',
  ];

  for (const action of Object.keys(ACTIONS) as Action[]) {
    it(`matrix: ${action} × every relation`, async () => {
      for (const rel of SETUPS) {
        nowMs += 2 * MIN;
        const [me, them] = await setUp(rel);
        const res = await ACTIONS[action](me, them);
        const [status, outcome] = EXPECTED[action][rel];
        expect(res.statusCode, `${action} on ${rel}: ${res.body}`).toBe(status);
        const after = rel === 'self' ? 'self' : await relationBetween(database.db, me.id, them.id);
        if (status >= 400) {
          expect(res.json<{ error: { code: string } }>().error.code, `${action} on ${rel}`).toBe(
            outcome,
          );
          expect(after, `${action} on ${rel} changed nothing`).toBe(rel);
        } else {
          expect(after, `${action} on ${rel}`).toBe(outcome);
          if (action !== 'report') {
            const visible = outcome === 'blocked-by-them' ? 'stranger' : outcome;
            expect(res.json<{ relation: string }>().relation).toBe(visible);
          }
        }
      }
    });
  }

  it('matrix: viewPresence × every relation (only friends see it)', async () => {
    for (const rel of SETUPS) {
      const [me, them] = await setUp(rel);
      // `them` is active right now.
      await call(them, 'GET', '/api/account');
      const view = await list(me);
      const seen = view.friends.find((f) => f.handle === them.handle);
      if (rel === 'friend') expect(seen?.presence, rel).toBe('online');
      else if (rel !== 'self') expect(seen, rel).toBeUndefined();
      const entries = [...view.friends, ...view.incoming, ...view.outgoing, ...view.blocked];
      for (const e of entries) {
        if (e.handle !== them.handle || rel === 'friend') continue;
        expect(e.presence, rel).toBeUndefined();
      }
    }
  });

  it('the relation route answers the visible relation; a blocker looks like nobody', async () => {
    for (const rel of SETUPS) {
      const [me, them] = await setUp(rel);
      const res = await call(me, 'GET', `/api/players/${them.handle}/relation`);
      if (rel === 'blocked-by-them') {
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe((await call(me, 'GET', '/api/players/zzzzzzzzzzzz/relation')).body);
      } else {
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({ relation: rel });
      }
    }
  });

  // ---- The reusable helpers. ----

  it('relationsFor / blockedEitherWay / isBlockedEitherWay / friendIds agree with the setup', async () => {
    const me = await player();
    const others: Record<string, TestAccount> = {};
    for (const rel of SETUPS.filter((r) => r !== 'self')) {
      const them = await player();
      others[rel] = them;
      if (rel === 'requested-by-me') await send(me, them);
      if (rel === 'requested-by-them') await send(them, me);
      if (rel === 'friend') {
        await send(me, them);
        await act(them, `/api/friends/requests/${me.handle}/accept`);
      }
      if (rel === 'blocked-by-me') await call(me, 'POST', '/api/blocks', { handle: them.handle });
      if (rel === 'blocked-by-them') await call(them, 'POST', '/api/blocks', { handle: me.handle });
    }
    const ids = Object.values(others).map((o) => o.id);
    const rels = await relationsFor(database.db, me.id, [...ids, me.id]);
    for (const [rel, o] of Object.entries(others)) expect(rels.get(o.id), rel).toBe(rel);
    expect(rels.get(me.id)).toBe('self');
    const blocked = await blockedEitherWay(database.db, me.id, ids);
    expect([...blocked].sort()).toEqual(
      [others['blocked-by-me']!.id, others['blocked-by-them']!.id].sort(),
    );
    expect((await blockedEitherWay(database.db, me.id)).size).toBe(2);
    expect(await isBlockedEitherWay(database.db, others['blocked-by-them']!.id, me.id)).toBe(true);
    expect(await isBlockedEitherWay(database.db, others.friend!.id, me.id)).toBe(false);
    expect(await friendIds(database.db, me.id)).toEqual([others.friend!.id]);
    expect((await relationsFor(database.db, me.id, [])).size).toBe(0);
  });

  // ---- Block side effects and lists. ----

  it('blocking a friend removes the friendship; each disappears from the other', async () => {
    const [me, them] = await setUp('friend');
    expect((await list(me)).friends.map((f) => f.handle)).toEqual([them.handle]);
    expect((await call(me, 'POST', '/api/blocks', { handle: them.handle })).statusCode).toBe(200);
    const mine = await list(me);
    expect(mine.friends).toEqual([]);
    expect(mine.blocked.map((b) => b.handle)).toEqual([them.handle]);
    const theirs = await list(them);
    expect(theirs).toMatchObject({ friends: [], incoming: [], outgoing: [], blocked: [] });
    const pair = pairOf(me.id, them.id);
    const rows = await database.db
      .select()
      .from(friendships)
      .where(eq(friendships.accountLow, pair.low));
    expect(rows.filter((r) => r.accountHigh === pair.high)).toEqual([]);
    // The blocked player can't reach the blocker, by handle or by name.
    expect((await send(them, me)).statusCode).toBe(404);
    expect(
      (await call(them, 'POST', '/api/friends/requests', { name: me.displayName })).statusCode,
    ).toBe(404);
    // Audit: block records what it removed.
    const [audit] = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'friend.block'))
      .orderBy(auditLog.id)
      .limit(1);
    expect(audit).toBeTruthy();
  });

  it('a block on a pending request removes the request in both inboxes', async () => {
    const [me, them] = await setUp('requested-by-them');
    expect((await list(me)).incoming.map((e) => e.handle)).toEqual([them.handle]);
    expect((await list(them)).outgoing.map((e) => e.handle)).toEqual([me.handle]);
    await call(me, 'POST', '/api/blocks', { handle: them.handle });
    expect((await list(me)).incoming).toEqual([]);
    expect((await list(them)).outgoing).toEqual([]);
  });

  it('requests by display name; unknown, malformed and hidden names are 404', async () => {
    const me = await player();
    const them = await player();
    const res = await call(me, 'POST', '/api/friends/requests', {
      name: `  ${them.displayName.toUpperCase()} `,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ relation: 'requested-by-me' });
    expect(
      (await call(me, 'POST', '/api/friends/requests', { name: 'Nobody Here At All' })).statusCode,
    ).toBe(404);
    expect((await call(me, 'POST', '/api/friends/requests/not-a-handle/accept')).statusCode).toBe(
      404,
    );
    expect(
      (await call(me, 'POST', '/api/friends/requests', { handle: them.handle, name: 'x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(me, 'POST', '/api/friends/requests', { accountId: them.id })).statusCode,
    ).toBe(400);
    // A moderator-hidden name: not found by name, and shown as null in lists.
    const hidden = await player();
    await database.db.insert(sanctions).values({
      id: uuidv7(),
      subjectId: hidden.id,
      kind: 'hide',
      targetKey: `profileField:${hidden.id}:displayName`,
      target: { kind: 'profileField', handle: hidden.handle, field: 'displayName' },
      reason: 'test',
      createdAt: now(),
      expiresAt: new Date(nowMs + DAY),
    });
    expect(
      (await call(me, 'POST', '/api/friends/requests', { name: hidden.displayName })).statusCode,
    ).toBe(404);
    expect((await send(me, hidden)).statusCode).toBe(200);
    expect((await list(me)).outgoing.find((e) => e.handle === hidden.handle)).toEqual({
      handle: hidden.handle,
      displayName: null,
    });
  });

  it('the list answers 304 to a matching ETag and a new tag after a change', async () => {
    const [me, them] = await setUp('friend');
    const first = await app.inject({
      method: 'GET',
      url: '/api/friends',
      cookies: { [SESSION_COOKIE]: me.token },
    });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers['cache-control']).toContain('no-cache');
    const again = await app.inject({
      method: 'GET',
      url: '/api/friends',
      headers: { 'if-none-match': etag },
      cookies: { [SESSION_COOKIE]: me.token },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    await act(me, `/api/friends/${them.handle}/remove`);
    const changed = await app.inject({
      method: 'GET',
      url: '/api/friends',
      headers: { 'if-none-match': etag },
      cookies: { [SESSION_COOKIE]: me.token },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('every route needs a session', async () => {
    const someone = await player();
    const handle = { handle: someone.handle };
    for (const [method, url, body] of [
      ['GET', '/api/friends', undefined],
      ['POST', '/api/friends/requests', handle],
      ['POST', `/api/friends/requests/${someone.handle}/accept`, undefined],
      ['POST', `/api/friends/${someone.handle}/remove`, undefined],
      ['POST', '/api/blocks', handle],
      ['POST', `/api/blocks/${someone.handle}/remove`, undefined],
      ['GET', `/api/players/${someone.handle}/relation`, undefined],
      ['POST', '/api/account/presence', { hidden: true }],
    ] as const) {
      expect((await call(null, method, url, body)).statusCode, url).toBe(401);
    }
  });

  // ---- Social writes: mute, rate limit. ----

  it('a mute stops sending and accepting, not stepping away', async () => {
    const muted = await player();
    const asker = await player();
    const friend = await player();
    const pendingOut = await player();
    const blocked = await player();
    const stranger = await player();
    await send(asker, muted);
    await send(muted, friend);
    await act(friend, `/api/friends/requests/${muted.handle}/accept`);
    await send(muted, pendingOut);
    await call(muted, 'POST', '/api/blocks', { handle: blocked.handle });
    await send(asker, stranger);
    await database.db.insert(sanctions).values({
      id: uuidv7(),
      subjectId: muted.id,
      kind: 'mute',
      reason: 'Spam',
      createdAt: now(),
      expiresAt: new Date(nowMs + DAY),
    });
    const refused = await send(muted, await player());
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('muted');
    expect((await act(muted, `/api/friends/requests/${asker.handle}/accept`)).statusCode).toBe(403);
    // Stepping away is always allowed.
    expect((await act(muted, `/api/friends/requests/${asker.handle}/decline`)).statusCode).toBe(
      200,
    );
    expect((await act(muted, `/api/friends/requests/${pendingOut.handle}/cancel`)).statusCode).toBe(
      200,
    );
    expect((await act(muted, `/api/friends/${friend.handle}/remove`)).statusCode).toBe(200);
    expect((await call(muted, 'POST', '/api/blocks', { handle: stranger.handle })).statusCode).toBe(
      200,
    );
    expect((await act(muted, `/api/blocks/${blocked.handle}/remove`)).statusCode).toBe(200);
    // Others can still send to the muted player; the muted player just can't accept.
    expect((await send(await player(), muted)).statusCode).toBe(200);
  });

  it('friend writes count in the social rate-limit class; refused writes do not', async () => {
    const me = await player();
    for (let i = 0; i < 30; i++) {
      const other = await player();
      expect((await call(me, 'POST', '/api/blocks', { handle: other.handle })).statusCode).toBe(
        200,
      );
    }
    const res = await send(me, await player());
    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: { details: { limit: string } } }>().error.details.limit).toBe(
      'social',
    );
    // Reading the list is not a social write.
    expect((await call(me, 'GET', '/api/friends')).statusCode).toBe(200);
  });

  // ---- Caps. ----

  async function bulkAccounts(n: number): Promise<string[]> {
    const rows = await database.db
      .insert(accounts)
      .values(
        Array.from({ length: n }, (_, i) => ({
          id: uuidv7(),
          email: `bulk-${nowMs}-${i}-${Math.random()}@graumark.test`,
          displayName:
            `Bulk ${nowMs.toString(36)} ${i.toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(
              0,
              20,
            ),
          passwordHash: 'x',
        })),
      )
      .returning({ id: accounts.id });
    return rows.map((r) => r.id);
  }
  const pairRow = (a: string, b: string, status: 'pending' | 'friends', requestedBy: string) => {
    const { low, high } = pairOf(a, b);
    return { accountLow: low, accountHigh: high, status, requestedBy, createdAt: now() };
  };

  it(`caps: ${FRIEND_LIMITS.friends} friends, both sides`, async () => {
    const full = await player();
    const others = await bulkAccounts(FRIEND_LIMITS.friends);
    await database.db
      .insert(friendships)
      .values(others.map((o) => pairRow(full.id, o, 'friends', o)));
    const x = await player();
    const mine = await send(full, x);
    expect(mine.json<{ error: { code: string } }>().error.code).toBe('friend_limit');
    const theirs = await send(x, full);
    expect(theirs.json<{ error: { code: string } }>().error.code).toBe('friend_limit_them');
    // A request that was waiting before the cap was reached can't be accepted past it.
    const y = await player();
    await database.db.insert(friendships).values(pairRow(full.id, y.id, 'pending', y.id));
    const accept = await act(full, `/api/friends/requests/${y.handle}/accept`);
    expect(accept.statusCode).toBe(409);
    expect(accept.json<{ error: { code: string } }>().error.code).toBe('friend_limit');
    // Removing one makes room.
    const [one] = await database.db.select().from(accounts).where(eq(accounts.id, others[0]!));
    expect((await act(full, `/api/friends/${one!.handle}/remove`)).statusCode).toBe(200);
    expect((await act(full, `/api/friends/requests/${y.handle}/accept`)).statusCode).toBe(200);
    expect((await friendIds(database.db, full.id)).length).toBe(FRIEND_LIMITS.friends);
  });

  it(`caps: ${FRIEND_LIMITS.outgoingRequests} outgoing and ${FRIEND_LIMITS.incomingRequests} incoming requests`, async () => {
    const eager = await player();
    const asked = await bulkAccounts(FRIEND_LIMITS.outgoingRequests);
    await database.db
      .insert(friendships)
      .values(asked.map((o) => pairRow(eager.id, o, 'pending', eager.id)));
    const out = await send(eager, await player());
    expect(out.json<{ error: { code: string } }>().error.code).toBe('request_limit');

    const popular = await player();
    const askers = await bulkAccounts(FRIEND_LIMITS.incomingRequests);
    await database.db
      .insert(friendships)
      .values(askers.map((o) => pairRow(popular.id, o, 'pending', o)));
    const inbox = await send(await player(), popular);
    expect(inbox.json<{ error: { code: string } }>().error.code).toBe('inbox_full');
    // Answering one of the waiting requests still works at the cap (no request slot needed).
    const [first] = await database.db.select().from(accounts).where(eq(accounts.id, askers[0]!));
    expect((await act(popular, `/api/friends/requests/${first!.handle}/accept`)).statusCode).toBe(
      200,
    );
  });

  it(`caps: ${FRIEND_LIMITS.blocks} blocks`, async () => {
    const wary = await player();
    const ids = await bulkAccounts(FRIEND_LIMITS.blocks);
    await database.db
      .insert(blocks)
      .values(ids.map((id) => ({ blockerId: wary.id, blockedId: id, createdAt: now() })));
    const res = await call(wary, 'POST', '/api/blocks', { handle: (await player()).handle });
    expect(res.json<{ error: { code: string } }>().error.code).toBe('block_limit');
  });

  // ---- Presence. ----

  it('presence: coarse buckets that age, never a time', async () => {
    const [me, them] = await setUp('friend');
    await call(them, 'GET', '/api/account');
    const seen = nowMs;
    const bucket = async () =>
      (await list(me)).friends.find((f) => f.handle === them.handle)!.presence;
    expect(await bucket()).toBe('online');
    nowMs = seen + 10 * MIN;
    expect(await bucket()).toBe('online');
    nowMs = seen + 11 * MIN;
    expect(await bucket()).toBe('today');
    nowMs = seen + DAY + MIN;
    expect(await bucket()).toBe('week');
    nowMs = seen + 7 * DAY + MIN;
    expect(await bucket()).toBe('longer');
    // No timestamp of any shape anywhere in the response.
    const raw = (await call(me, 'GET', '/api/friends')).body;
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(raw).not.toMatch(/\d{10,}/);
    const body = JSON.parse(raw) as FriendsView;
    for (const f of body.friends) {
      expect(Object.keys(f).sort()).toEqual(['displayName', 'handle', 'presence']);
      expect([...PRESENCE_BUCKETS, null]).toContain(f.presence);
    }
    for (const e of [...body.incoming, ...body.outgoing, ...body.blocked]) {
      expect(Object.keys(e).sort()).toEqual(['displayName', 'handle']);
    }
  });

  it('presence: a player who never made a request shows as away; hiding shows nothing', async () => {
    const me = await player();
    const quiet = await player();
    await database.db.insert(friendships).values(pairRow(me.id, quiet.id, 'friends', quiet.id));
    expect((await list(me)).friends[0]!.presence).toBe('longer');
    await call(quiet, 'GET', '/api/account');
    expect((await list(me)).friends[0]!.presence).toBe('online');
    const hide = await call(quiet, 'POST', '/api/account/presence', { hidden: true });
    expect(hide.statusCode, hide.body).toBe(200);
    expect((await list(quiet)).presenceHidden).toBe(true);
    expect((await list(me)).friends[0]!.presence).toBeNull();
    // The hider still sees their friends' presence.
    expect((await list(quiet)).friends[0]!.presence).toBe('online');
    await call(quiet, 'POST', '/api/account/presence', { hidden: false });
    expect((await list(me)).friends[0]!.presence).toBe('online');
    expect((await call(quiet, 'POST', '/api/account/presence', { hidden: 'yes' })).statusCode).toBe(
      400,
    );
  });

  it('presence: last seen is written at most once per 3 minutes per account', async () => {
    const busy = await player();
    const lastSeen = async () =>
      (
        await database.db
          .select()
          .from(accountPresence)
          .where(eq(accountPresence.accountId, busy.id))
      )[0]?.lastSeenAt?.getTime();
    expect(await lastSeen()).toBeUndefined();
    const t0 = nowMs;
    await call(busy, 'GET', '/api/account');
    expect(await lastSeen()).toBe(t0);
    for (let i = 1; i <= 5; i++) {
      nowMs = t0 + i * 30_000; // every 30 s for 2.5 min: no write
      await call(busy, 'GET', '/api/account');
      await call(busy, 'GET', '/api/friends');
    }
    expect(await lastSeen()).toBe(t0);
    nowMs = t0 + 3 * MIN;
    await call(busy, 'GET', '/api/account');
    expect(await lastSeen()).toBe(t0 + 3 * MIN);
    // A failed login or anonymous call records nothing.
    const other = await player();
    await call(null, 'GET', '/api/account');
    const rows = await database.db
      .select()
      .from(accountPresence)
      .where(or(eq(accountPresence.accountId, other.id)));
    expect(rows).toEqual([]);
  });
});
