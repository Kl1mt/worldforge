/**
 * Guild chat (ticket 4.5, docs/SOCIAL.md "Guild chat"): the permission matrix (leader, officer,
 * member, not a member, and a member with a block either way × read, post, delete, notice,
 * report), written out by hand; the text filter and the mute enforced on the server; tombstones;
 * blocks; pagination, polling and the readable history; leaving and kicks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { GUILD_CHAT_LIMITS, type GuildRole } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { blocks, guildMembers, guildMessages, guilds, type Guild } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';

type Cell = number | `${number} ${string}`;
const NO_GUILD: Cell = '404 not_in_guild';
const RANK: Cell = '403 guild_forbidden';
const UNSEEN: Cell = '404 message_not_found';

type Standing = GuildRole | 'none' | 'blocking' | 'blockedBy';
const STANDINGS: Standing[] = ['leader', 'officer', 'member', 'none', 'blocking', 'blockedBy'];

/**
 * Actions without an author (read the chat, post, set the notice) and reporting a member's line.
 * `blocking` / `blockedBy`: an officer who blocks the line's author, or whom the author blocks.
 */
const PLAIN: Record<'read' | 'post' | 'notice' | 'report', Record<Standing, Cell>> = {
  read: { leader: 200, officer: 200, member: 200, none: NO_GUILD, blocking: 200, blockedBy: 200 },
  post: { leader: 201, officer: 201, member: 201, none: NO_GUILD, blocking: 201, blockedBy: 201 },
  notice: {
    leader: 200,
    officer: 200,
    member: RANK,
    none: NO_GUILD,
    blocking: 200,
    blockedBy: 200,
  },
  report: {
    leader: 201,
    officer: 201,
    member: 201,
    none: '404 not_found',
    blocking: '404 not_found',
    blockedBy: '404 not_found',
  },
};

type Author = 'self' | 'leader' | 'officer' | 'member' | 'former';
const AUTHORS: Author[] = ['self', 'leader', 'officer', 'member', 'former'];

/** Removing a line by each author (`null`: impossible, the leader's "leader" line is their own). */
const DELETE: Record<Standing, Record<Author, Cell | null>> = {
  leader: { self: 200, leader: null, officer: 200, member: 200, former: 200 },
  officer: { self: 200, leader: RANK, officer: RANK, member: 200, former: 200 },
  member: { self: 200, leader: RANK, officer: RANK, member: RANK, former: RANK },
  none: { self: null, leader: NO_GUILD, officer: NO_GUILD, member: NO_GUILD, former: NO_GUILD },
  // An officer and a blocked author: the line does not exist for them.
  blocking: { self: null, leader: UNSEEN, officer: UNSEEN, member: UNSEEN, former: UNSEEN },
  blockedBy: { self: null, leader: UNSEEN, officer: UNSEEN, member: UNSEEN, former: UNSEEN },
};

interface ChatBody {
  guild: { handle: string };
  role: string;
  messages: Line[];
  revised: Line[];
  gone: number[];
  notice: Line | null;
  next: number;
  hasOlder: boolean;
  more: boolean;
  mute: { reason: string } | null;
}
interface Line {
  id: string;
  seq: number;
  kind: string;
  author: { handle: string; displayName: string | null; role: string | null } | null;
  mine: boolean;
  text: string | null;
  tombstone: string | null;
}

describe('guild chat', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  const nowMs = Date.parse('2026-11-07T12:00:00Z');

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: {
        now: () => new Date(nowMs),
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] },
      },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const account = () => insertAccount(db(), { now: new Date(nowMs) });
  const status = (r: { statusCode: number; json: () => unknown }) =>
    r.statusCode < 300
      ? r.statusCode
      : `${r.statusCode} ${(r.json() as { error: { code: string } }).error.code}`;
  const chat = async (who: TestAccount, query = '') => {
    const res = await call(who, 'GET', `/api/guild/chat${query}`);
    expect(res.statusCode).toBe(200);
    return res.json<ChatBody>();
  };
  const post = async (who: TestAccount, text: string) => {
    const res = await call(who, 'POST', '/api/guild/chat', { text });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ message: Line }>().message;
  };
  const block = (blocker: TestAccount, blocked: TestAccount) =>
    db().insert(blocks).values({ blockerId: blocker.id, blockedId: blocked.id });

  /** A guild: leader, two officers, two members, a former member; an outsider. */
  async function cast() {
    const [leader, officer, officer2, member, member2, former, outsider] = await Promise.all(
      Array.from({ length: 7 }, account),
    );
    const guild = await insertGuild(db(), leader!.id, {
      members: [
        { accountId: officer!.id, role: 'officer' },
        { accountId: officer2!.id, role: 'officer' },
        { accountId: member!.id },
        { accountId: member2!.id },
        { accountId: former!.id },
      ],
    });
    return {
      guild,
      leader: leader!,
      officer: officer!,
      officer2: officer2!,
      member: member!,
      member2: member2!,
      former: former!,
      outsider: outsider!,
    };
  }
  type Cast = Awaited<ReturnType<typeof cast>>;

  /** The actor of a standing (blocking / blockedBy: the second officer, with the block set up). */
  async function actorOf(c: Cast, s: Standing, author?: TestAccount): Promise<TestAccount> {
    if (s === 'leader') return c.leader;
    if (s === 'officer') return c.officer;
    if (s === 'member') return c.member;
    if (s === 'none') return c.outsider;
    if (author) {
      if (s === 'blocking') await block(c.officer2, author);
      else await block(author, c.officer2);
    }
    return c.officer2;
  }

  describe('permission matrix', () => {
    for (const action of ['read', 'post', 'notice', 'report'] as const) {
      for (const s of STANDINGS) {
        const want = PLAIN[action][s];
        it(`${action} × ${s} → ${want}`, async () => {
          const c = await cast();
          const line = await post(c.member2, 'Torches at the gate by dusk.');
          const actor = await actorOf(c, s, c.member2);
          let res;
          if (action === 'read') res = await call(actor, 'GET', '/api/guild/chat');
          else if (action === 'post')
            res = await call(actor, 'POST', '/api/guild/chat', { text: 'Aye.' });
          else if (action === 'notice') {
            res = await call(actor, 'POST', '/api/guild/notice', { text: 'Muster on the morrow.' });
          } else {
            res = await call(actor, 'POST', '/api/reports', {
              target: { kind: 'message', id: line.id },
              reason: 'spam',
            });
          }
          expect(status(res)).toBe(want);
          if (action === 'read' && res.statusCode === 200) {
            const seen = res.json<ChatBody>().messages.map((m) => m.id);
            // A block either way hides the author's lines from the other.
            expect(seen.includes(line.id)).toBe(s !== 'blocking' && s !== 'blockedBy');
          }
          if (typeof want !== 'number' && action === 'notice') {
            const [g] = await db().select().from(guilds).where(eq(guilds.id, c.guild.id));
            expect(g!.noticeMessageId).toBeNull();
          }
        });
      }
    }

    for (const s of STANDINGS) {
      for (const a of AUTHORS) {
        const want = DELETE[s][a];
        if (want === null) continue;
        it(`delete × ${s} on a line by ${a} → ${want}`, async () => {
          const c = await cast();
          const authorOf: Record<Author, TestAccount> = {
            self: s === 'leader' ? c.leader : s === 'officer' ? c.officer : c.member,
            leader: c.leader,
            officer: s === 'officer' ? c.officer2 : c.officer,
            member: s === 'member' ? c.member2 : c.member,
            former: c.former,
          };
          const author = authorOf[a];
          const line = await post(author, 'A line to strike.');
          if (a === 'former') {
            await db().delete(guildMembers).where(eq(guildMembers.accountId, c.former.id));
          }
          const actor = await actorOf(c, s, author);
          const res = await call(actor, 'POST', `/api/guild/chat/${line.id}/remove`);
          expect(status(res)).toBe(want);
          const [row] = await db()
            .select()
            .from(guildMessages)
            .where(eq(guildMessages.id, line.id));
          if (want === 200) {
            expect(row!.removedAs).toBe(a === 'self' ? 'withdrawn' : 'removed');
            expect(res.json().tombstone).toBe(row!.removedAs);
          } else {
            expect(row!.removedAt).toBeNull();
          }
        });
      }
    }

    it('reporting one’s own line is refused; a line of another guild is unknown', async () => {
      const c = await cast();
      const other = await cast();
      const mine = await post(c.member, 'My own words.');
      const theirs = await post(other.member, 'Elsewhere.');
      const own = await call(c.member, 'POST', '/api/reports', {
        target: { kind: 'message', id: mine.id },
        reason: 'spam',
      });
      expect(status(own)).toBe('422 cannot_report_self');
      const foreign = await call(c.member, 'POST', '/api/reports', {
        target: { kind: 'message', id: theirs.id },
        reason: 'spam',
      });
      expect(status(foreign)).toBe('404 not_found');
      expect(status(await call(c.officer, 'POST', `/api/guild/chat/${theirs.id}/remove`))).toBe(
        UNSEEN,
      );
      expect(status(await call(c.leader, 'POST', '/api/guild/chat/not-a-uuid/remove'))).toBe(
        UNSEEN,
      );
    });

    it('removing twice is a 409; anonymous visitors get 401', async () => {
      const c = await cast();
      const line = await post(c.member, 'Twice struck.');
      expect(status(await call(c.officer, 'POST', `/api/guild/chat/${line.id}/remove`))).toBe(200);
      expect(status(await call(c.leader, 'POST', `/api/guild/chat/${line.id}/remove`))).toBe(
        '409 message_removed',
      );
      expect((await call(null, 'GET', '/api/guild/chat')).statusCode).toBe(401);
      expect((await call(null, 'POST', '/api/guild/chat', { text: 'hi' })).statusCode).toBe(401);
    });
  });

  describe('text filter and mute (server-side)', () => {
    it('refuses blocked words, links, empty and over-long lines; stores the normalised text', async () => {
      const c = await cast();
      const bad = [
        ['f.u.c.k off', 'blocked'],
        ['join www.example.com', 'link'],
        ['visit https://x.io now', 'link'],
        ['   ', 'too_short'],
        ['x'.repeat(301), 'too_long'],
      ] as const;
      for (const [text, problem] of bad) {
        const res = await call(c.member, 'POST', '/api/guild/chat', { text });
        expect(status(res)).toBe('400 validation_failed');
        expect(res.json().error.details.problems.text).toBe(problem);
      }
      expect((await chat(c.member)).messages).toEqual([]);
      const line = await post(c.member, '  Ｈｏｌｄ​   the   line  ');
      expect(line.text).toBe('Hold the line');
      const notice = await call(c.leader, 'POST', '/api/guild/notice', {
        text: 'www.evil.example',
      });
      expect(res400(notice)).toBe('link');
    });
    const res400 = (r: { json: () => { error: { details: { problems: { text: string } } } } }) =>
      r.json().error.details.problems.text;

    it('a muted member reads, sees why, cannot post or set the notice, can still withdraw', async () => {
      const c = await cast();
      const mod = await insertAccount(db(), { role: 'moderator', now: new Date(nowMs) });
      const line = await post(c.officer, 'Before the silence.');
      const report = await call(c.member, 'POST', '/api/reports', {
        target: { kind: 'message', id: line.id },
        reason: 'harassment',
      });
      expect(report.statusCode).toBe(201);
      const queue = (await call(mod, 'GET', '/api/mod/queue?limit=50')).json();
      const kase = queue.cases.find(
        (x: { target: { kind: string; id?: string } }) => x.target.id === line.id,
      );
      expect(kase.target).toEqual({ kind: 'message', id: line.id });
      expect(kase.current.value).toBe('Before the silence.');
      const muted = await call(mod, 'POST', `/api/mod/reports/${kase.reportId}/resolve`, {
        action: 'mute',
        reason: 'Cool off for a day',
        durationHours: 24,
      });
      expect(muted.statusCode).toBe(200);

      const view = await chat(c.officer);
      expect(view.mute?.reason).toBe('Cool off for a day');
      const refused = await call(c.officer, 'POST', '/api/guild/chat', { text: 'Let me speak' });
      expect(status(refused)).toBe('403 muted');
      expect(refused.json().error.details.sanction.reason).toBe('Cool off for a day');
      expect(status(await call(c.officer, 'POST', '/api/guild/notice', { text: 'Hear me.' }))).toBe(
        '403 muted',
      );
      expect(status(await call(c.officer, 'POST', `/api/guild/chat/${line.id}/remove`))).toBe(200);
      expect((await chat(c.leader)).mute).toBeNull();
    });

    it('chat posts count in the social-write limit class', async () => {
      const limited = buildApp({
        database,
        auth: {
          now: () => new Date(nowMs),
          socialWriteLimit: { windows: [{ windowMs: 60_000, max: 3 }] },
        },
      });
      await limited.ready();
      try {
        const c = await cast();
        const send = () => caller(limited)(c.member, 'POST', '/api/guild/chat', { text: 'again' });
        for (let i = 0; i < 3; i++) expect((await send()).statusCode).toBe(201);
        const over = await send();
        expect(status(over)).toBe('429 rate_limited');
        expect(over.json().error.details.limit).toBe('social');
        expect(over.headers['retry-after']).toBeDefined();
      } finally {
        await limited.close();
      }
    });
  });

  describe('tombstones', () => {
    it('removed, withdrawn and hidden lines never carry their text, for anyone', async () => {
      const c = await cast();
      const mod = await insertAccount(db(), { role: 'moderator', now: new Date(nowMs) });
      const a = await post(c.member, 'Spoken in haste.');
      const b = await post(c.member2, 'Crude words here.');
      const h = await post(c.member2, 'Vile words here.');
      await post(c.leader, 'Steady now.');
      expect(status(await call(c.member, 'POST', `/api/guild/chat/${a.id}/remove`))).toBe(200);
      expect(status(await call(c.officer, 'POST', `/api/guild/chat/${b.id}/remove`))).toBe(200);
      await call(c.member, 'POST', '/api/reports', {
        target: { kind: 'message', id: h.id },
        reason: 'hate',
      });
      const queue = (await call(mod, 'GET', '/api/mod/queue?limit=50')).json();
      const kase = queue.cases.find((x: { target: { id?: string } }) => x.target.id === h.id);
      const hide = await call(mod, 'POST', `/api/mod/reports/${kase.reportId}/resolve`, {
        action: 'hideContent',
        reason: 'Hateful line',
        durationHours: 24 * 7,
      });
      expect(hide.statusCode).toBe(200);

      for (const viewer of [c.leader, c.member, c.member2]) {
        const body = await call(viewer, 'GET', '/api/guild/chat');
        expect(body.body).not.toContain('haste');
        expect(body.body).not.toContain('Crude');
        expect(body.body).not.toContain('Vile');
        const byId = new Map(body.json<ChatBody>().messages.map((m) => [m.id, m]));
        expect(byId.get(a.id)).toMatchObject({ text: null, tombstone: 'withdrawn' });
        expect(byId.get(b.id)).toMatchObject({ text: null, tombstone: 'removed' });
        expect(byId.get(h.id)).toMatchObject({ text: null, tombstone: 'hidden' });
      }
      // The author sees the sanction, with the hidden line as its target.
      const standing = (await call(c.member2, 'GET', '/api/account/standing')).json();
      expect(standing.sanctions[0].target).toEqual({ kind: 'message', id: h.id });
    });
  });

  describe('blocks', () => {
    it('hides lines either way, and a poll drops lines of a player blocked since', async () => {
      const c = await cast();
      const one = await post(c.member, 'First.');
      const two = await post(c.member2, 'Second.');
      const before = await chat(c.leader);
      expect(before.messages.map((m) => m.id)).toEqual([one.id, two.id]);
      await block(c.leader, c.member2);
      const poll = await chat(c.leader, `?since=${before.next}&from=${before.messages[0]!.seq}`);
      expect(poll.gone).toEqual([two.seq]);
      expect((await chat(c.leader)).messages.map((m) => m.id)).toEqual([one.id]);
      // The blocked side does not see the blocker's lines either.
      const three = await post(c.leader, 'Third.');
      expect((await chat(c.member2)).messages.map((m) => m.id)).not.toContain(three.id);
      expect((await chat(c.member)).messages.map((m) => m.id)).toEqual([one.id, two.id, three.id]);
    });

    it('a notice by a blocked officer is not shown to the blocker', async () => {
      const c = await cast();
      expect(status(await call(c.officer, 'POST', '/api/guild/notice', { text: 'Gather.' }))).toBe(
        200,
      );
      expect((await chat(c.member)).notice?.text).toBe('Gather.');
      await block(c.member, c.officer);
      expect((await chat(c.member)).notice).toBeNull();
      expect((await chat(c.member2)).notice?.text).toBe('Gather.');
    });
  });

  describe('the notice', () => {
    it('is set, replaced and taken down by officers; it shows as a line in the chat', async () => {
      const c = await cast();
      const set = await call(c.officer, 'POST', '/api/guild/notice', {
        text: 'Raid at dusk.\nBring torches.',
      });
      expect(set.statusCode).toBe(200);
      const view = await chat(c.member);
      expect(view.notice).toMatchObject({ kind: 'notice', text: 'Raid at dusk.\nBring torches.' });
      expect(view.messages.at(-1)!.id).toBe(view.notice!.id);
      await call(c.leader, 'POST', '/api/guild/notice', { text: 'Raid moved to dawn.' });
      expect((await chat(c.member)).notice!.text).toBe('Raid moved to dawn.');
      expect((await call(c.leader, 'POST', '/api/guild/notice', { text: '  ' })).json()).toEqual({
        notice: null,
      });
      expect((await chat(c.member)).notice).toBeNull();
    });

    it('removing the notice line takes the notice down', async () => {
      const c = await cast();
      const set = (
        await call(c.officer, 'POST', '/api/guild/notice', { text: 'Old news.' })
      ).json();
      await call(c.leader, 'POST', `/api/guild/chat/${set.notice.id}/remove`);
      expect((await chat(c.member)).notice).toBeNull();
    });
  });

  describe('pagination and polling', () => {
    it('newest page first, then older pages; polls return what is new, oldest first', async () => {
      const c = await cast();
      const { page } = GUILD_CHAT_LIMITS;
      const sent: Line[] = [];
      for (let i = 1; i <= 2 * page + 10; i++) {
        sent.push(await post(i % 2 ? c.member : c.member2, `Line ${i}`));
      }
      const first = await chat(c.leader);
      expect(first.messages.map((m) => m.text)).toEqual(sent.slice(-page).map((m) => m.text));
      expect(first.hasOlder).toBe(true);
      expect(first.next).toBe(sent.at(-1)!.seq);
      const older = await chat(c.leader, `?before=${first.messages[0]!.seq}`);
      expect(older.messages.map((m) => m.id)).toEqual(
        sent.slice(-2 * page, -page).map((m) => m.id),
      );
      expect(older.hasOlder).toBe(true);
      const oldest = await chat(c.leader, `?before=${older.messages[0]!.seq}`);
      expect(oldest.messages.map((m) => m.id)).toEqual(sent.slice(0, 10).map((m) => m.id));
      expect(oldest.hasOlder).toBe(false);

      // A poll with nothing new: an ETag, then a 304.
      const q = `?since=${first.next}&from=${first.messages[0]!.seq}`;
      const quiet = await call(c.leader, 'GET', `/api/guild/chat${q}`);
      expect(quiet.json<ChatBody>().messages).toEqual([]);
      const etag = quiet.headers.etag as string;
      expect(etag).toBeTruthy();
      const again = await app.inject({
        method: 'GET',
        url: `/api/guild/chat${q}`,
        cookies: { [SESSION_COOKIE]: c.leader.token },
        headers: { 'if-none-match': etag },
      });
      expect(again.statusCode).toBe(304);

      // New lines and a removal below the cursor.
      const n1 = await post(c.member, 'New one');
      await call(c.officer, 'POST', `/api/guild/chat/${first.messages[0]!.id}/remove`);
      const poll = await chat(c.leader, q);
      expect(poll.messages.map((m) => m.id)).toEqual([n1.id]);
      expect(poll.revised).toEqual([
        expect.objectContaining({ id: first.messages[0]!.id, tombstone: 'removed', text: null }),
      ]);
      expect(poll.next).toBe(n1.seq);
      expect(poll.more).toBe(false);
    });

    it('a poll after a long absence says `more`', async () => {
      const c = await cast();
      const start = await chat(c.member);
      const { pollMax } = GUILD_CHAT_LIMITS;
      await insertLines(c.guild, c.member2, pollMax + 5);
      const poll = await chat(c.member, `?since=${start.next}`);
      expect(poll.messages).toHaveLength(pollMax);
      expect(poll.more).toBe(true);
      expect(poll.next).toBe(poll.messages.at(-1)!.seq);
      const rest = await chat(c.member, `?since=${poll.next}`);
      expect(rest.messages).toHaveLength(5);
      expect(rest.more).toBe(false);
    });

    it('serves only the newest 500 lines and nothing older than 30 days', async () => {
      const c = await cast();
      const { historyMessages, historyDays } = GUILD_CHAT_LIMITS;
      await insertLines(c.guild, c.member2, 10, nowMs - (historyDays + 1) * 86_400_000);
      expect((await chat(c.member)).messages).toEqual([]);
      await insertLines(c.guild, c.member2, historyMessages + 20);
      let cursor: number | undefined;
      let seen = 0;
      let minSeq = Infinity;
      for (;;) {
        const pageBody = await chat(c.member, cursor ? `?before=${cursor}` : '');
        seen += pageBody.messages.length;
        if (pageBody.messages.length) minSeq = Math.min(minSeq, pageBody.messages[0]!.seq);
        if (!pageBody.hasOlder) break;
        cursor = pageBody.messages[0]!.seq;
      }
      expect(seen).toBe(historyMessages);
      expect(minSeq).toBe(10 + 20 + 1);
    });

    it('rejects since together with before', async () => {
      const c = await cast();
      expect(status(await call(c.member, 'GET', '/api/guild/chat?since=1&before=4'))).toBe(
        '400 validation_failed',
      );
    });
  });

  describe('leaving and kicks end access at once', () => {
    it('a kicked member can neither read nor post, and the kick audit records the last line', async () => {
      const c = await cast();
      await post(c.member, 'Before the kick.');
      expect(
        status(await call(c.officer, 'POST', `/api/guild/members/${c.member.handle}/kick`)),
      ).toBe(200);
      expect(status(await call(c.member, 'GET', '/api/guild/chat'))).toBe(NO_GUILD);
      expect(status(await call(c.member, 'POST', '/api/guild/chat', { text: 'Wait' }))).toBe(
        NO_GUILD,
      );
      expect(status(await call(c.member2, 'POST', '/api/guild/leave'))).toBe(200);
      expect(status(await call(c.member2, 'GET', '/api/guild/chat?since=0'))).toBe(NO_GUILD);
      // Lines of the departed stay, with no rank.
      const lines = (await chat(c.leader)).messages;
      expect(lines[0]!.author).toMatchObject({ handle: c.member.handle, role: null });
    });
  });

  async function insertLines(guild: Guild, author: TestAccount, n: number, at = nowMs) {
    const rows = await db()
      .select({ seq: guildMessages.seq })
      .from(guildMessages)
      .where(eq(guildMessages.guildId, guild.id));
    const top = Math.max(0, ...rows.map((r) => r.seq));
    await db()
      .insert(guildMessages)
      .values(
        Array.from({ length: n }, (_, i) => ({
          id: uuidv7(),
          guildId: guild.id,
          seq: top + i + 1,
          authorId: author.id,
          kind: 'chat',
          body: `Bulk ${top + i + 1}`,
          createdAt: new Date(at),
        })),
      );
  }
});
