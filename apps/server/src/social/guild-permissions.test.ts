/**
 * Guild permission matrix (ticket 4.4, docs/SOCIAL.md "Guilds"): every guild standing (leader,
 * officer, member, not a member) × every guild action, and for the member actions every target
 * (the leader, an officer, a member, a non-member, oneself), through the HTTP API, plus the block
 * cells. The expected table is written out by hand, so a rule change has to change it here too.
 * Each cell runs on a fresh guild; refused cells must change nothing.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  GUILD_ACTIONS,
  GUILD_CREATE_COST,
  GUILD_STANDINGS,
  GUILD_TARGET_ACTIONS,
  type GuildAction,
  type GuildStanding,
  type GuildTargetAction,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  characters,
  guildApplications,
  guildInvites,
  guildMembers,
  guilds,
  type Guild,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';

type Cell = number | `${number} ${string}`;
const OK = 200;
const IN_GUILD: Cell = '409 already_in_guild';
const NO_GUILD: Cell = '404 not_in_guild';
const RANK: Cell = '403 guild_forbidden';
const SELF: Cell = '422 cannot_target_self';
const NOT_MEMBER: Cell = '404 not_a_member';

type PlainAction = Exclude<GuildAction, GuildTargetAction>;

/** Actions without a target: expected answer per actor standing. */
const PLAIN: Record<PlainAction, Record<GuildStanding, Cell>> = {
  create: { leader: IN_GUILD, officer: IN_GUILD, member: IN_GUILD, none: 201 },
  apply: { leader: IN_GUILD, officer: IN_GUILD, member: IN_GUILD, none: OK },
  acceptInvite: { leader: IN_GUILD, officer: IN_GUILD, member: IN_GUILD, none: OK },
  cancelApplication: { leader: OK, officer: OK, member: OK, none: OK },
  declineInvite: { leader: OK, officer: OK, member: OK, none: OK },
  viewRequests: { leader: OK, officer: OK, member: RANK, none: NO_GUILD },
  invite: { leader: OK, officer: OK, member: RANK, none: NO_GUILD },
  cancelInvite: { leader: OK, officer: OK, member: RANK, none: NO_GUILD },
  acceptApplication: { leader: OK, officer: OK, member: RANK, none: NO_GUILD },
  declineApplication: { leader: OK, officer: OK, member: RANK, none: NO_GUILD },
  setEmblem: { leader: OK, officer: RANK, member: RANK, none: NO_GUILD },
  rename: { leader: OK, officer: RANK, member: RANK, none: NO_GUILD },
  disband: { leader: OK, officer: RANK, member: RANK, none: NO_GUILD },
  leave: { leader: '409 leader_must_hand_over', officer: OK, member: OK, none: NO_GUILD },
};

type TargetKind = 'leader' | 'officer' | 'member' | 'none' | 'self';
const TARGETS: TargetKind[] = ['leader', 'officer', 'member', 'none', 'self'];
/** `null`: impossible (the leader's target "the leader" is the leader themselves, `self`). */
type TargetRow = Record<TargetKind, Cell | null>;

const ONLY_LEADER_ROWS = (leader: TargetRow): Record<GuildStanding, TargetRow> => ({
  leader,
  officer: { leader: RANK, officer: RANK, member: RANK, none: RANK, self: SELF },
  member: { leader: RANK, officer: RANK, member: RANK, none: RANK, self: SELF },
  none: { leader: NO_GUILD, officer: NO_GUILD, member: NO_GUILD, none: NO_GUILD, self: NO_GUILD },
});

const TARGETED: Record<GuildTargetAction, Record<GuildStanding, TargetRow>> = {
  kick: {
    leader: { leader: null, officer: OK, member: OK, none: NOT_MEMBER, self: SELF },
    officer: { leader: RANK, officer: RANK, member: OK, none: NOT_MEMBER, self: SELF },
    member: { leader: RANK, officer: RANK, member: RANK, none: RANK, self: SELF },
    none: { leader: NO_GUILD, officer: NO_GUILD, member: NO_GUILD, none: NO_GUILD, self: NO_GUILD },
  },
  promote: ONLY_LEADER_ROWS({
    leader: null,
    officer: '409 already_officer',
    member: OK,
    none: NOT_MEMBER,
    self: SELF,
  }),
  demote: ONLY_LEADER_ROWS({
    leader: null,
    officer: OK,
    member: '409 not_an_officer',
    none: NOT_MEMBER,
    self: SELF,
  }),
  transferLeadership: ONLY_LEADER_ROWS({
    leader: null,
    officer: OK,
    member: OK,
    none: NOT_MEMBER,
    self: SELF,
  }),
};

const TARGET_PATH: Record<GuildTargetAction, string> = {
  kick: 'kick',
  promote: 'promote',
  demote: 'demote',
  transferLeadership: 'transfer',
};

describe('guild permission matrix', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const account = () => insertAccount(db());

  /**
   * A fresh guild: the leader, two officers, two members; two outsiders; another guild. The cast
   * by standing: the actor of each standing and a second account of the same standing (the
   * "other officer", "other member", "other outsider").
   */
  async function world() {
    const [leader, o1, o2, m1, m2, n1, n2, x, otherLeader] = await Promise.all(
      Array.from({ length: 9 }, () => account()),
    );
    const guild = await insertGuild(db(), leader!.id, {
      members: [
        { accountId: o1!.id, role: 'officer' },
        { accountId: o2!.id, role: 'officer' },
        { accountId: m1!.id },
        { accountId: m2!.id },
      ],
    });
    const other = await insertGuild(db(), otherLeader!.id);
    const actorOf: Record<GuildStanding, TestAccount> = {
      leader: leader!,
      officer: o1!,
      member: m1!,
      none: n1!,
    };
    const secondOf: Record<GuildStanding, TestAccount> = {
      leader: leader!,
      officer: o2!,
      member: m2!,
      none: n2!,
    };
    const people = [leader, o1, o2, m1, m2, n1, n2, x, otherLeader].map((a) => a!.id);
    return { guild, other, leader: leader!, x: x!, actorOf, secondOf, people };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** A snapshot of everything a guild action may change. */
  async function state(w: World) {
    const ids = [w.guild.id, w.other.id];
    const [members, invites, applications, rows] = await Promise.all([
      db().select().from(guildMembers),
      db().select().from(guildInvites),
      db().select().from(guildApplications),
      db().select().from(guilds),
    ]);
    const mine = <T extends { guildId: string }>(r: T[]) =>
      JSON.stringify(
        r
          .filter(
            (x) =>
              ids.includes(x.guildId) ||
              ('accountId' in x && w.people.includes(x.accountId as string)),
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    return [
      mine(members),
      mine(invites),
      mine(applications),
      JSON.stringify(
        rows.filter((g) => ids.includes(g.id)).sort((a, b) => a.id.localeCompare(b.id)),
      ),
    ].join('|');
  }

  type Res = { statusCode: number; json: () => unknown };
  /** Seeds what the action needs, and returns the call that performs it. */
  async function prepare(
    w: World,
    action: PlainAction,
    actor: TestAccount,
  ): Promise<() => Promise<Res>> {
    const g: Guild = w.guild;
    switch (action) {
      case 'create': {
        const hero = await insertCharacter(db(), actor.id);
        await db()
          .update(characters)
          .set({ gold: GUILD_CREATE_COST })
          .where(eq(characters.id, hero.id));
        const tag = randomUUID()
          .replace(/[^0-9]/g, '')
          .slice(0, 4);
        return () =>
          app.inject({
            method: 'POST',
            url: '/api/guilds',
            payload: { characterId: hero.id, name: `Matrix Hall ${tag}`, tag: `M${tag}` },
            headers: { 'idempotency-key': randomUUID() },
            cookies: { [SESSION_COOKIE]: actor.token },
          });
      }
      case 'apply':
        return () => call(actor, 'POST', `/api/guilds/${g.handle}/apply`);
      case 'acceptInvite':
        await db()
          .insert(guildInvites)
          .values({ guildId: g.id, accountId: actor.id, invitedBy: w.leader.id });
        return () => call(actor, 'POST', `/api/guilds/${g.handle}/invite/accept`);
      case 'cancelApplication':
        await db().insert(guildApplications).values({ guildId: w.other.id, accountId: actor.id });
        return () => call(actor, 'POST', `/api/guilds/${w.other.handle}/application/cancel`);
      case 'declineInvite':
        await db().insert(guildInvites).values({ guildId: w.other.id, accountId: actor.id });
        return () => call(actor, 'POST', `/api/guilds/${w.other.handle}/invite/decline`);
      case 'viewRequests': {
        await db().insert(guildApplications).values({ guildId: g.id, accountId: w.x.id });
        return async () => {
          const res = await call(actor, 'GET', '/api/guild');
          const body = res.json();
          // Answered as a status for the table: sees the application, sees none, has no guild.
          const status = !body.guild
            ? '404 not_in_guild'
            : body.guild.applications.length === 1
              ? 200
              : '403 guild_forbidden';
          return {
            statusCode: typeof status === 'number' ? status : Number(status.slice(0, 3)),
            json: () => (typeof status === 'number' ? {} : { error: { code: status.slice(4) } }),
          };
        };
      }
      case 'invite':
        return () => call(actor, 'POST', '/api/guild/invites', { handle: w.x.handle });
      case 'cancelInvite':
        await db()
          .insert(guildInvites)
          .values({ guildId: g.id, accountId: w.x.id, invitedBy: w.leader.id });
        return () => call(actor, 'POST', `/api/guild/invites/${w.x.handle}/cancel`);
      case 'acceptApplication':
        await db().insert(guildApplications).values({ guildId: g.id, accountId: w.x.id });
        return () => call(actor, 'POST', `/api/guild/applications/${w.x.handle}/accept`);
      case 'declineApplication':
        await db().insert(guildApplications).values({ guildId: g.id, accountId: w.x.id });
        return () => call(actor, 'POST', `/api/guild/applications/${w.x.handle}/decline`);
      case 'setEmblem':
        return () => call(actor, 'POST', '/api/guild/emblem', { emblem: 'tower' });
      case 'rename':
        await db()
          .update(guilds)
          .set({ renameRequired: true, renamedFrom: g.name })
          .where(eq(guilds.id, g.id));
        return () =>
          call(actor, 'POST', '/api/guild/rename', {
            name: `Renamed ${g.tag.slice(1)}x`,
            tag: `R${g.tag.slice(1, 4)}`,
          });
      case 'disband':
        return () => call(actor, 'POST', '/api/guild/disband', { name: g.name });
      case 'leave':
        return () => call(actor, 'POST', '/api/guild/leave');
    }
  }

  const answer = (res: { statusCode: number; json: () => unknown }): Cell => {
    if (res.statusCode < 300) return res.statusCode;
    const body = res.json() as { error: { code: string } };
    return `${res.statusCode} ${body.error.code}` as Cell;
  };

  const actionsCovered = new Set<GuildAction>();

  for (const action of GUILD_ACTIONS.filter(
    (a): a is PlainAction => !(GUILD_TARGET_ACTIONS as readonly string[]).includes(a),
  )) {
    actionsCovered.add(action);
    for (const standing of GUILD_STANDINGS) {
      it(`${standing} → ${action}`, async () => {
        const w = await world();
        const actor = w.actorOf[standing];
        const want = PLAIN[action][standing];
        const run = await prepare(w, action, actor);
        const before = await state(w);
        const res = await run();
        expect(answer(res)).toBe(want);
        // Refused actions change nothing; allowed writes change something (reads never do).
        const after = await state(w);
        if (typeof want !== 'number' || action === 'viewRequests') expect(after).toBe(before);
        else expect(after).not.toBe(before);
      });
    }
  }

  for (const action of GUILD_TARGET_ACTIONS) {
    actionsCovered.add(action);
    for (const standing of GUILD_STANDINGS) {
      for (const t of TARGETS) {
        const want = TARGETED[action][standing][t];
        if (want === null) continue;
        it(`${standing} → ${action} on ${t}`, async () => {
          const w = await world();
          const actor = w.actorOf[standing];
          const target =
            t === 'self'
              ? actor
              : t === 'leader'
                ? w.leader
                : standing === t
                  ? w.secondOf[t]
                  : w.actorOf[t];
          const before = await state(w);
          const res = await call(
            actor,
            'POST',
            `/api/guild/members/${target.handle}/${TARGET_PATH[action]}`,
          );
          expect(answer(res)).toBe(want);
          const after = await state(w);
          if (want === OK) expect(after).not.toBe(before);
          else expect(after).toBe(before);
        });
      }
    }
  }

  it('every guild action is in the table', () => {
    expect([...actionsCovered].sort()).toEqual([...GUILD_ACTIONS].sort());
  });

  describe('blocks (either way)', () => {
    async function blocked(by: TestAccount, whom: TestAccount) {
      const res = await call(by, 'POST', '/api/blocks', { handle: whom.handle });
      expect(res.statusCode, res.body).toBe(200);
    }

    const BLOCK_CELLS: [
      string,
      Cell,
      (w: World) => Promise<{ statusCode: number; json: () => unknown }>,
    ][] = [
      [
        'invite a player you block',
        '409 blocked_by_you',
        async (w) => {
          await blocked(w.leader, w.x);
          return call(w.leader, 'POST', '/api/guild/invites', { handle: w.x.handle });
        },
      ],
      [
        'invite a player who blocks you',
        '404 not_found',
        async (w) => {
          await blocked(w.x, w.leader);
          return call(w.leader, 'POST', '/api/guild/invites', { handle: w.x.handle });
        },
      ],
      [
        'apply to a guild whose leader you block',
        '404 not_found',
        async (w) => {
          await blocked(w.x, w.leader);
          return call(w.x, 'POST', `/api/guilds/${w.guild.handle}/apply`);
        },
      ],
      [
        'apply to a guild whose leader blocks you',
        '404 not_found',
        async (w) => {
          await blocked(w.leader, w.x);
          return call(w.x, 'POST', `/api/guilds/${w.guild.handle}/apply`);
        },
      ],
      [
        'accept an application from a player who blocks the officer',
        '404 no_application',
        async (w) => {
          await db().insert(guildApplications).values({ guildId: w.guild.id, accountId: w.x.id });
          await blocked(w.x, w.actorOf.officer);
          return call(w.actorOf.officer, 'POST', `/api/guild/applications/${w.x.handle}/accept`);
        },
      ],
      [
        'accept an invite from an officer you blocked since',
        '404 no_invite',
        async (w) => {
          await db()
            .insert(guildInvites)
            .values({ guildId: w.guild.id, accountId: w.x.id, invitedBy: w.actorOf.officer.id });
          await blocked(w.x, w.actorOf.officer);
          return call(w.x, 'POST', `/api/guilds/${w.guild.handle}/invite/accept`);
        },
      ],
      [
        'kick a member you block (still allowed)',
        OK,
        async (w) => {
          await blocked(w.leader, w.actorOf.member);
          return call(w.leader, 'POST', `/api/guild/members/${w.actorOf.member.handle}/kick`);
        },
      ],
    ];

    for (const [name, want, run] of BLOCK_CELLS) {
      it(name, async () => {
        const w = await world();
        const res = await run(w);
        expect(answer(res)).toBe(want);
      });
    }
  });
});
