/**
 * Guilds (ticket 4.4, docs/SOCIAL.md "Guilds"): founding (gold, Idempotency-Key, text module,
 * uniqueness, one guild per account), invites and applications, roles, leaving, kicks, disbanding,
 * blocks, guildmates' presence and profile privacy, reports and moderator actions, mutes and the
 * social rate limit. The permission matrix is `guild-permissions.test.ts`; races are
 * `guilds.pg.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, like } from 'drizzle-orm';
import { GUILD_CREATE_COST, GUILD_LIMITS } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  characters,
  guildApplications,
  guildInvites,
  guildMembers,
  guilds,
  sanctions,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { areGuildmates, guildmateIds } from './guild-model.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface MyGuild {
  guild: null | {
    handle: string;
    name: string;
    tag: string;
    role: string;
    memberCount: number;
    renameRequired: boolean;
    renameReason: string | null;
    members: {
      handle: string;
      displayName: string | null;
      role: string;
      presence: string | null;
      blocked: boolean;
    }[];
    invites: { player: { handle: string } }[];
    applications: { player: { handle: string } }[];
  };
  invites: { guild: { handle: string; name: string }; invitedBy: { handle: string } | null }[];
  applications: { guild: { handle: string } }[];
  notice: null | { kind: string; guildName: string; reason: string | null };
}

describe('guilds (ticket 4.4)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2026-11-06T12:00:00Z');
  const now = () => new Date(nowMs);
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 1000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
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

  const db = () => database.db;
  const player = () => insertAccount(db(), { now: now() });
  const ok = async (p: Promise<{ statusCode: number; body: string }>) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(200);
    return r;
  };
  const code = async (p: Promise<{ statusCode: number; json: () => unknown }>) => {
    const r = await p;
    const body = r.json() as { error?: { code: string } };
    return [r.statusCode, body.error?.code ?? null];
  };
  const mine = async (who: TestAccount) => (await call(who, 'GET', '/api/guild')).json<MyGuild>();

  async function hero(acc: TestAccount, gold = GUILD_CREATE_COST + 500) {
    const h = await insertCharacter(db(), acc.id);
    await db().update(characters).set({ gold }).where(eq(characters.id, h.id));
    return h;
  }

  const found = (
    who: TestAccount,
    body: Record<string, unknown>,
    key: string | null = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/guilds',
      payload: body,
      headers: key ? { 'idempotency-key': key } : {},
      cookies: { [SESSION_COOKIE]: who.token },
    });

  let names = 0;
  const fresh = () => {
    names += 1;
    // Decimal digits only (6.9: base-36 "1", "I" and "L" look alike and are refused as names).
    const n = String(names);
    return { name: `Ashen Wardens ${n}`, tag: `AW${n}`.slice(0, 5) };
  };

  /** A founded guild (through the API) with members who joined by invite. */
  async function guildWith(memberCount = 0) {
    const leader = await player();
    const h = await hero(leader);
    const res = await found(leader, { characterId: h.id, ...fresh() });
    expect(res.statusCode, res.body).toBe(201);
    const handle = res.json().guild.handle as string;
    const members: TestAccount[] = [];
    for (let i = 0; i < memberCount; i++) {
      const m = await player();
      await ok(call(leader, 'POST', '/api/guild/invites', { handle: m.handle }));
      await ok(call(m, 'POST', `/api/guilds/${handle}/invite/accept`));
      members.push(m);
    }
    return { leader, handle, members };
  }

  describe('founding', () => {
    it('charges the chosen hero, is audited, recorded and replayed under the same key', async () => {
      const leader = await player();
      const h = await hero(leader, 6000);
      const key = randomUUID();
      const body = { characterId: h.id, name: 'The Grey Lantern', tag: 'gl', emblem: 'crow' };
      const res = await found(leader, body, key);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        guild: { name: 'The Grey Lantern', tag: 'GL', emblem: 'crow', memberCount: 1 },
        character: { id: h.id, gold: 6000 - GUILD_CREATE_COST },
      });
      const again = await found(leader, body, key);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.json()).toEqual(res.json());
      const [row] = await db().select().from(characters).where(eq(characters.id, h.id));
      expect(row!.gold).toBe(6000 - GUILD_CREATE_COST);
      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, leader.id), eq(auditLog.event, 'guild.create')));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.characterId).toBe(h.id);
      expect(audits[0]!.data).toMatchObject({ gold: GUILD_CREATE_COST, goldAfter: 1000 });
      const checks = await reconcileWithAudit(db());
      for (const c of checks.filter((c) => c.check.startsWith('guilds:'))) {
        expect(c, c.check).toMatchObject({ ok: true });
      }
      const view = await mine(leader);
      expect(view.guild).toMatchObject({
        name: 'The Grey Lantern',
        role: 'leader',
        memberCount: 1,
      });
    });

    it('refuses without gold, without a key, or with another account’s hero; nothing is charged', async () => {
      const leader = await player();
      const poor = await hero(leader, GUILD_CREATE_COST - 1);
      expect(await code(found(leader, { characterId: poor.id, ...fresh() }))).toEqual([
        422,
        'insufficient_gold',
      ]);
      const other = await player();
      const theirs = await hero(other);
      expect(await code(found(leader, { characterId: theirs.id, ...fresh() }))).toEqual([
        404,
        'not_found',
      ]);
      const rich = await hero(leader);
      expect(await code(found(leader, { characterId: rich.id, ...fresh() }, null))).toEqual([
        400,
        'idempotency_key_required',
      ]);
      const rows = await db()
        .select({ gold: characters.gold })
        .from(characters)
        .where(inArray(characters.id, [poor.id, theirs.id, rich.id]));
      expect(rows.map((r) => r.gold).sort()).toEqual(
        [GUILD_CREATE_COST - 1, GUILD_CREATE_COST + 500, GUILD_CREATE_COST + 500].sort(),
      );
      expect((await mine(leader)).guild).toBeNull();
    });

    it('name and tag go through the text module and are unique case-insensitively', async () => {
      const a = await player();
      const b = await player();
      const ha = await hero(a);
      const hb = await hero(b);
      const bad = async (name: string, tag: string) => {
        const res = await found(b, { characterId: hb.id, name, tag });
        return [
          res.statusCode,
          res.json().error.code,
          Object.keys(res.json().error.details?.problems ?? res.json().error.details?.fields ?? {}),
        ];
      };
      expect(await bad('ab', 'OK')).toEqual([400, 'validation_failed', ['name']]);
      expect(await bad('Fuck Squad', 'OK')).toEqual([400, 'validation_failed', ['name']]);
      expect(await bad('Admin Guild', 'OK')).toEqual([400, 'validation_failed', ['name']]);
      expect(await bad('Visit www.spam.com', 'OK')).toEqual([400, 'validation_failed', ['name']]);
      expect(await bad('Fine Name', 'A')).toEqual([400, 'validation_failed', ['tag']]);
      expect(await bad('Fine Name', 'G-M')).toEqual([400, 'validation_failed', ['tag']]);
      // NFKC: full-width letters become plain.
      const first = await found(a, {
        characterId: ha.id,
        name: 'Ｉｒｏｎ Ｃｏｖｅｎａｎｔ',
        tag: 'ic',
      });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json().guild).toMatchObject({ name: 'Iron Covenant', tag: 'IC' });
      expect(
        await code(found(b, { characterId: hb.id, name: 'iron COVENANT', tag: 'ZZ' })),
      ).toEqual([409, 'guild_name_taken']);
      expect(await code(found(b, { characterId: hb.id, name: 'Another Name', tag: 'Ic' }))).toEqual(
        [409, 'guild_tag_taken'],
      );
      const [row] = await db().select().from(characters).where(eq(characters.id, hb.id));
      expect(row!.gold).toBe(GUILD_CREATE_COST + 500);
    });

    it('one guild per account: a member or leader cannot found another', async () => {
      const { leader, members } = await guildWith(1);
      const h1 = await hero(leader);
      const h2 = await hero(members[0]!);
      expect(await code(found(leader, { characterId: h1.id, ...fresh() }))).toEqual([
        409,
        'already_in_guild',
      ]);
      expect(await code(found(members[0]!, { characterId: h2.id, ...fresh() }))).toEqual([
        409,
        'already_in_guild',
      ]);
    });
  });

  describe('invites and applications', () => {
    it('invite → accept; the invite shows in the invitee’s inbox with who sent it', async () => {
      const { leader, handle } = await guildWith();
      const recruit = await player();
      await ok(call(leader, 'POST', '/api/guild/invites', { name: recruit.displayName }));
      expect(
        await code(call(leader, 'POST', '/api/guild/invites', { handle: recruit.handle })),
      ).toEqual([409, 'invite_pending']);
      const inbox = await mine(recruit);
      expect(inbox.invites).toMatchObject([
        { guild: { handle }, invitedBy: { handle: leader.handle } },
      ]);
      expect((await mine(leader)).guild!.invites).toMatchObject([
        { player: { handle: recruit.handle } },
      ]);
      await ok(call(recruit, 'POST', `/api/guilds/${handle}/invite/accept`));
      const view = await mine(recruit);
      expect(view.guild).toMatchObject({ handle, role: 'member', memberCount: 2 });
      expect(view.invites).toEqual([]);
      expect(await areGuildmates(db(), leader.id, recruit.id)).toBe(true);
    });

    it('apply → an officer accepts; applying when invited joins at once, inviting an applicant too', async () => {
      const { leader, handle } = await guildWith();
      const a = await player();
      await ok(call(a, 'POST', `/api/guilds/${handle}/apply`));
      expect(await code(call(a, 'POST', `/api/guilds/${handle}/apply`))).toEqual([
        409,
        'application_pending',
      ]);
      expect((await mine(a)).applications).toMatchObject([{ guild: { handle } }]);
      expect((await mine(leader)).guild!.applications).toMatchObject([
        { player: { handle: a.handle } },
      ]);
      await ok(call(leader, 'POST', `/api/guild/applications/${a.handle}/accept`));
      expect((await mine(a)).guild?.handle).toBe(handle);

      const b = await player();
      await ok(call(leader, 'POST', '/api/guild/invites', { handle: b.handle }));
      await ok(call(b, 'POST', `/api/guilds/${handle}/apply`));
      expect((await mine(b)).guild?.handle).toBe(handle);

      const c = await player();
      await ok(call(c, 'POST', `/api/guilds/${handle}/apply`));
      await ok(call(leader, 'POST', '/api/guild/invites', { handle: c.handle }));
      expect((await mine(c)).guild?.handle).toBe(handle);
      const joins = await db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.event, 'guild.join'), inArray(auditLog.accountId, [a.id, b.id, c.id])),
        );
      expect(joins.map((j) => j.data.via).sort()).toEqual(['application', 'application', 'invite']);
    });

    it('decline, cancel and withdraw; joining drops every other offer', async () => {
      const g1 = await guildWith();
      const g2 = await guildWith();
      const g3 = await guildWith();
      const p = await player();
      await ok(call(g1.leader, 'POST', '/api/guild/invites', { handle: p.handle }));
      await ok(call(g2.leader, 'POST', '/api/guild/invites', { handle: p.handle }));
      await ok(call(p, 'POST', `/api/guilds/${g3.handle}/apply`));
      await ok(call(p, 'POST', `/api/guilds/${g1.handle}/invite/decline`));
      expect(await code(call(p, 'POST', `/api/guilds/${g1.handle}/invite/accept`))).toEqual([
        404,
        'no_invite',
      ]);
      await ok(call(g2.leader, 'POST', `/api/guild/invites/${p.handle}/cancel`));
      expect(await code(call(p, 'POST', `/api/guilds/${g2.handle}/invite/accept`))).toEqual([
        404,
        'no_invite',
      ]);
      await ok(call(p, 'POST', `/api/guilds/${g3.handle}/application/cancel`));
      expect(
        await code(call(g3.leader, 'POST', `/api/guild/applications/${p.handle}/accept`)),
      ).toEqual([404, 'no_application']);
      // Offers everywhere, then join one: the rest are gone.
      await ok(call(g1.leader, 'POST', '/api/guild/invites', { handle: p.handle }));
      await ok(call(p, 'POST', `/api/guilds/${g2.handle}/apply`));
      await ok(call(p, 'POST', `/api/guilds/${g3.handle}/apply`));
      await ok(call(g3.leader, 'POST', `/api/guild/applications/${p.handle}/decline`));
      await ok(call(p, 'POST', `/api/guilds/${g1.handle}/invite/accept`));
      const left = await Promise.all([
        db().select().from(guildInvites).where(eq(guildInvites.accountId, p.id)),
        db().select().from(guildApplications).where(eq(guildApplications.accountId, p.id)),
      ]);
      expect(left).toEqual([[], []]);
      // A member cannot apply or take another invite.
      expect(await code(call(p, 'POST', `/api/guilds/${g2.handle}/apply`))).toEqual([
        409,
        'already_in_guild',
      ]);
      expect(
        await code(call(g2.leader, 'POST', '/api/guild/invites', { handle: p.handle })),
      ).toEqual([409, 'target_in_guild']);
    });

    it(`caps: ${GUILD_LIMITS.members} members, ${GUILD_LIMITS.applicationsPerAccount} applications per player`, async () => {
      const leader = await player();
      const others = await Promise.all(
        Array.from({ length: GUILD_LIMITS.members - 1 }, () => player()),
      );
      const g = await insertGuild(db(), leader.id, {
        members: others.map((o) => ({ accountId: o.id })),
      });
      const late = await player();
      expect(await code(call(late, 'POST', `/api/guilds/${g.handle}/apply`))).toEqual([
        409,
        'guild_full',
      ]);
      expect(
        await code(call(leader, 'POST', '/api/guild/invites', { handle: late.handle })),
      ).toEqual([409, 'guild_full']);
      // An invite sent before the guild filled cannot be accepted once it is full.
      await ok(call(others[0]!, 'POST', '/api/guild/leave'));
      await ok(call(leader, 'POST', '/api/guild/invites', { handle: late.handle }));
      const filler = await player();
      await db()
        .insert(guildMembers)
        .values({ accountId: filler.id, guildId: g.id, role: 'member', joinedAt: now() });
      expect(await code(call(late, 'POST', `/api/guilds/${g.handle}/invite/accept`))).toEqual([
        409,
        'guild_full',
      ]);

      const applicant = await player();
      const targets = await Promise.all(
        Array.from({ length: GUILD_LIMITS.applicationsPerAccount + 1 }, () => guildWith()),
      );
      for (const t of targets.slice(0, -1)) {
        await ok(call(applicant, 'POST', `/api/guilds/${t.handle}/apply`));
      }
      expect(
        await code(call(applicant, 'POST', `/api/guilds/${targets.at(-1)!.handle}/apply`)),
      ).toEqual([409, 'application_limit']);
    });
  });

  describe('roles, leaving and disbanding', () => {
    it('promote, demote, transfer; officers may kick members but not officers', async () => {
      const { leader, members } = await guildWith(3);
      const [a, b, c] = members as [TestAccount, TestAccount, TestAccount];
      await ok(call(leader, 'POST', `/api/guild/members/${a.handle}/promote`));
      await ok(call(leader, 'POST', `/api/guild/members/${b.handle}/promote`));
      expect(await code(call(a, 'POST', `/api/guild/members/${b.handle}/kick`))).toEqual([
        403,
        'guild_forbidden',
      ]);
      await ok(call(a, 'POST', `/api/guild/members/${c.handle}/kick`));
      await ok(call(leader, 'POST', `/api/guild/members/${b.handle}/demote`));
      await ok(call(leader, 'POST', `/api/guild/members/${a.handle}/transfer`));
      const roles = Object.fromEntries(
        (await mine(a)).guild!.members.map((m) => [m.handle, m.role]),
      );
      expect(roles).toEqual({
        [a.handle]: 'leader',
        [leader.handle]: 'officer',
        [b.handle]: 'member',
      });
      expect((await mine(c)).notice).toMatchObject({ kind: 'kicked' });
      // The kicked member is no longer anyone's guildmate.
      expect(await guildmateIds(db(), a.id)).not.toContain(c.id);
    });

    it('the leader must hand over or disband; members leave freely', async () => {
      const { leader, handle, members } = await guildWith(1);
      expect(await code(call(leader, 'POST', '/api/guild/leave'))).toEqual([
        409,
        'leader_must_hand_over',
      ]);
      await ok(call(members[0]!, 'POST', '/api/guild/leave'));
      expect((await mine(members[0]!)).guild).toBeNull();
      expect((await mine(members[0]!)).notice).toBeNull();
      expect(await code(call(leader, 'POST', '/api/guild/leave'))).toEqual([
        409,
        'leader_must_hand_over',
      ]);
      expect((await mine(leader)).guild?.handle).toBe(handle);
    });

    it('disband needs the typed name, removes everyone and frees the name', async () => {
      const { leader, handle, members } = await guildWith(2);
      const view = (await mine(leader)).guild!;
      const pending = await player();
      await ok(call(leader, 'POST', '/api/guild/invites', { handle: pending.handle }));
      expect(await code(call(leader, 'POST', '/api/guild/disband', { name: 'wrong' }))).toEqual([
        422,
        'confirm_mismatch',
      ]);
      await ok(call(leader, 'POST', '/api/guild/disband', { name: view.name.toLowerCase() }));
      for (const m of [leader, ...members]) expect((await mine(m)).guild).toBeNull();
      expect((await mine(members[0]!)).notice).toMatchObject({
        kind: 'disbanded',
        guildName: view.name,
      });
      expect((await mine(leader)).notice).toBeNull();
      expect((await mine(pending)).invites).toEqual([]);
      expect((await call(pending, 'GET', `/api/guilds/${handle}`)).statusCode).toBe(404);
      const h = await hero(members[0]!);
      const again = await found(members[0]!, { characterId: h.id, name: view.name, tag: view.tag });
      expect(again.statusCode, again.body).toBe(201);
    });

    it('the leader picks an emblem from the list', async () => {
      const { leader, members } = await guildWith(1);
      await ok(call(leader, 'POST', '/api/guild/emblem', { emblem: 'skull' }));
      expect(
        (await call(leader, 'POST', '/api/guild/emblem', { emblem: 'upload.png' })).statusCode,
      ).toBe(400);
      expect(await code(call(members[0]!, 'POST', '/api/guild/emblem', { emblem: 'oak' }))).toEqual(
        [403, 'guild_forbidden'],
      );
      expect(
        (await call(leader, 'GET', `/api/guilds/${(await mine(leader)).guild!.handle}`)).json()
          .guild.emblem,
      ).toBe('skull');
    });
  });

  describe('blocks', () => {
    it('blocked players cannot invite or apply to each other', async () => {
      const { leader, handle } = await guildWith();
      const blocker = await player();
      const blocked = await player();
      await ok(call(leader, 'POST', '/api/blocks', { handle: blocked.handle }));
      await ok(call(blocker, 'POST', '/api/blocks', { handle: leader.handle }));
      // The leader blocks `blocked`: inviting them says so; `blocker` blocks the leader: unknown.
      expect(
        await code(call(leader, 'POST', '/api/guild/invites', { handle: blocked.handle })),
      ).toEqual([409, 'blocked_by_you']);
      expect(
        await code(call(leader, 'POST', '/api/guild/invites', { handle: blocker.handle })),
      ).toEqual([404, 'not_found']);
      // Either way the guild (the leader's) is invisible to them: profile, search, apply.
      const unknown = await call(blocked, 'GET', '/api/guilds/zzzzzzzzzzzz');
      for (const who of [blocked, blocker]) {
        const res = await call(who, 'GET', `/api/guilds/${handle}`);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(unknown.json());
        expect(await code(call(who, 'POST', `/api/guilds/${handle}/apply`))).toEqual([
          404,
          'not_found',
        ]);
        const search = (await call(who, 'GET', '/api/guilds')).json().guilds;
        expect(search.map((g: { handle: string }) => g.handle)).not.toContain(handle);
      }
    });

    it('an officer does not see or answer applications from players blocked either way', async () => {
      const { leader, handle, members } = await guildWith(1);
      const officer = members[0]!;
      await ok(call(leader, 'POST', `/api/guild/members/${officer.handle}/promote`));
      const applicant = await player();
      await ok(call(applicant, 'POST', `/api/guilds/${handle}/apply`));
      await ok(call(applicant, 'POST', '/api/blocks', { handle: officer.handle }));
      expect((await mine(officer)).guild!.applications).toEqual([]);
      expect(
        await code(call(officer, 'POST', `/api/guild/applications/${applicant.handle}/accept`)),
      ).toEqual([404, 'no_application']);
      expect((await mine(leader)).guild!.applications).toHaveLength(1);
    });

    it('a blocked guildmate stays on the roster without name or presence', async () => {
      const { leader, members } = await guildWith(2);
      const [a, b] = members as [TestAccount, TestAccount];
      await ok(call(a, 'POST', '/api/blocks', { handle: b.handle }));
      const seenByA = (await mine(a)).guild!.members.find((m) => m.handle === b.handle)!;
      expect(seenByA).toMatchObject({ displayName: null, presence: null, blocked: true });
      const seenByB = (await mine(b)).guild!.members.find((m) => m.handle === a.handle)!;
      expect(seenByB).toMatchObject({ displayName: a.displayName, presence: null, blocked: false });
      // The leader still kicks by handle.
      await ok(call(leader, 'POST', `/api/guild/members/${b.handle}/kick`));
    });
  });

  describe('presence and profiles (guildmates)', () => {
    it('guildmates see each other’s presence bucket (never a time); hidden is null', async () => {
      const { leader, members } = await guildWith(1);
      const m = members[0]!;
      await ok(call(m, 'GET', '/api/account'));
      const res = await call(leader, 'GET', '/api/guild');
      const entry = res.json<MyGuild>().guild!.members.find((x) => x.handle === m.handle)!;
      expect(entry.presence).toBe('online');
      // No timestamps anywhere in the body, only UTC days.
      expect(res.body).not.toMatch(/T\d{2}:\d{2}/);
      expect(res.body).not.toMatch(/\d{12,}/);
      nowMs += 2 * DAY;
      expect((await mine(leader)).guild!.members.find((x) => x.handle === m.handle)!.presence).toBe(
        'week',
      );
      await ok(call(m, 'POST', '/api/account/presence', { hidden: true }));
      expect(
        (await mine(leader)).guild!.members.find((x) => x.handle === m.handle)!.presence,
      ).toBeNull();
    });

    it('“friends and guild” profiles open to guildmates, and close at once when they leave', async () => {
      const { leader, members } = await guildWith(1);
      const m = members[0]!;
      await ok(
        call(m, 'POST', '/api/account/profile', {
          visibility: 'friendsAndGuild',
          shown: [],
          showcaseCharacterId: null,
        }),
      );
      const stranger = await player();
      expect((await call(leader, 'GET', `/api/players/${m.handle}/profile`)).statusCode).toBe(200);
      expect((await call(stranger, 'GET', `/api/players/${m.handle}/profile`)).statusCode).toBe(
        404,
      );
      await ok(call(leader, 'POST', `/api/guild/members/${m.handle}/kick`));
      expect((await call(leader, 'GET', `/api/players/${m.handle}/profile`)).statusCode).toBe(404);
    });

    it('a profile names the owner’s guild', async () => {
      const { leader, handle } = await guildWith();
      const viewer = await player();
      const view = (await call(viewer, 'GET', `/api/players/${leader.handle}/profile`)).json()
        .profile;
      expect(view.guild).toMatchObject({ handle, role: 'leader' });
      expect(JSON.stringify(view.guild)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  });

  describe('public profile, polling and privacy', () => {
    it('shows name, tag, members and roles; no ids, emails or presence', async () => {
      const { handle, members } = await guildWith(2);
      const viewer = await player();
      const res = await call(viewer, 'GET', `/api/guilds/${handle}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.standing).toBe('none');
      expect(body.members).toHaveLength(3);
      expect(body.members[0].role).toBe('leader');
      expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(res.body).not.toContain('@');
      expect(res.body).not.toContain('presence');
      expect(res.body).toContain(members[0]!.handle);
      expect(
        (await call(viewer, 'GET', '/api/guilds?q=ashen')).json().guilds.length,
      ).toBeGreaterThan(0);
    });

    it('the guild page carries an ETag; an unchanged page is a 304', async () => {
      const { leader } = await guildWith(1);
      const first = await call(leader, 'GET', '/api/guild');
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();
      const again = await app.inject({
        method: 'GET',
        url: '/api/guild',
        headers: { 'if-none-match': etag },
        cookies: { [SESSION_COOKIE]: leader.token },
      });
      expect(again.statusCode).toBe(304);
    });
  });

  describe('safety: reports, moderators, mutes and limits', () => {
    it('a guild can be reported; a moderator forces a rename, the leader renames', async () => {
      const { leader, handle, members } = await guildWith(1);
      const reporter = await player();
      const mod = await insertAccount(db(), { role: 'moderator', now: now() });
      const before = (await mine(leader)).guild!;
      const rep = await call(reporter, 'POST', '/api/reports', {
        target: { kind: 'guild', handle },
        reason: 'inappropriate',
      });
      expect(rep.statusCode, rep.body).toBe(201);
      const queue = (await call(mod, 'GET', '/api/mod/queue')).json().cases;
      const theCase = queue.find((c: { target: { handle: string } }) => c.target.handle === handle);
      expect(theCase).toMatchObject({
        target: { kind: 'guild', handle },
        subject: { handle: leader.handle },
        current: { value: `${before.name} [${before.tag}]` },
      });
      expect(
        await code(
          call(mod, 'POST', `/api/mod/reports/${theCase.reportId}/resolve`, {
            action: 'forceRename',
            reason: 'Offensive guild name',
            durationHours: 24 * 7,
          }),
        ),
      ).toEqual([422, 'use_rename_guild']);
      await ok(
        call(mod, 'POST', `/api/mod/reports/${theCase.reportId}/resolve`, {
          action: 'renameGuild',
          reason: 'Offensive guild name',
        }),
      );
      const seen = (await mine(members[0]!)).guild!;
      expect(seen).toMatchObject({ renameRequired: true, renameReason: 'Offensive guild name' });
      expect(seen.name).toMatch(/^Nameless Company \d{6}$/);
      expect(
        await code(call(members[0]!, 'POST', '/api/guild/rename', { name: 'Better', tag: 'BTR' })),
      ).toEqual([403, 'guild_forbidden']);
      expect(
        await code(
          call(leader, 'POST', '/api/guild/rename', {
            name: before.name.toUpperCase(),
            tag: 'BTR',
          }),
        ),
      ).toEqual([422, 'name_not_allowed']);
      await ok(call(leader, 'POST', '/api/guild/rename', { name: 'Kinder Company', tag: 'KND' }));
      expect((await mine(leader)).guild).toMatchObject({
        name: 'Kinder Company',
        tag: 'KND',
        renameRequired: false,
      });
      expect(
        await code(call(leader, 'POST', '/api/guild/rename', { name: 'Again', tag: 'AGN' })),
      ).toEqual([409, 'rename_not_required']);
      const audit = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, leader.id), like(auditLog.event, 'guild.%rename')));
      expect(audit.map((a) => a.event).sort()).toEqual(['guild.force_rename', 'guild.rename']);
    });

    it('a moderator disbands a guild; members see why', async () => {
      const { handle, members } = await guildWith(1);
      const reporter = await player();
      const mod = await insertAccount(db(), { role: 'moderator', now: now() });
      const rep = await call(reporter, 'POST', '/api/reports', {
        target: { kind: 'guild', handle },
        reason: 'hate',
      });
      await ok(
        call(mod, 'POST', `/api/mod/reports/${rep.json().report.id}/resolve`, {
          action: 'disbandGuild',
          reason: 'Hate group',
        }),
      );
      expect((await mine(members[0]!)).notice).toMatchObject({
        kind: 'disbandedByModerator',
        reason: 'Hate group',
      });
      const [g] = await db().select().from(guilds).where(eq(guilds.handle, handle));
      expect(g!.disbandedAt).not.toBeNull();
      // A player report cannot be used to disband a guild.
      const rep2 = await call(reporter, 'POST', '/api/reports', {
        target: { kind: 'player', handle: members[0]!.handle },
        reason: 'other',
      });
      expect(
        await code(
          call(mod, 'POST', `/api/mod/reports/${rep2.json().report.id}/resolve`, {
            action: 'disbandGuild',
            reason: 'Nope',
          }),
        ),
      ).toEqual([422, 'not_a_guild']);
    });

    it('a mute blocks reaching others (invite, apply, found) but not stepping away', async () => {
      const { leader, handle, members } = await guildWith(1);
      const other = await guildWith();
      const muted = members[0]!;
      // An invite left over from before they joined (inviting a member is refused).
      const [g2] = await db().select().from(guilds).where(eq(guilds.handle, other.handle));
      await db()
        .insert(guildInvites)
        .values({ guildId: g2!.id, accountId: muted.id, invitedBy: other.leader.id });
      await db()
        .insert(sanctions)
        .values({
          id: uuidv7(),
          subjectId: muted.id,
          kind: 'mute',
          reason: 'Spam',
          createdAt: now(),
          expiresAt: new Date(nowMs + DAY),
        });
      await ok(call(leader, 'POST', `/api/guild/members/${muted.handle}/promote`));
      const target = await player();
      expect(
        await code(call(muted, 'POST', '/api/guild/invites', { handle: target.handle })),
      ).toEqual([403, 'muted']);
      await ok(call(muted, 'POST', `/api/guilds/${other.handle}/invite/decline`));
      await ok(call(muted, 'POST', '/api/guild/leave'));
      expect(await code(call(muted, 'POST', `/api/guilds/${handle}/apply`))).toEqual([
        403,
        'muted',
      ]);
      const h = await hero(muted);
      expect(await code(found(muted, { characterId: h.id, ...fresh() }))).toEqual([403, 'muted']);
    });

    it('guild writes count against the social rate limit', async () => {
      const limited = buildApp({
        database,
        auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 2 }] } },
        activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
      });
      await limited.ready();
      const c = caller(limited);
      const { leader } = await guildWith();
      const targets = await Promise.all([player(), player(), player()]);
      for (const t of targets.slice(0, 2))
        await ok(c(leader, 'POST', '/api/guild/invites', { handle: t.handle }));
      const res = await c(leader, 'POST', '/api/guild/invites', { handle: targets[2]!.handle });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.details.limit).toBe('social');
      await limited.close();
    });
  });
});
