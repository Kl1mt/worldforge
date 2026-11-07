/**
 * Real-PostgreSQL races for guild chat (ticket 4.5, docs/SOCIAL.md "Guild chat"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Lines get `seq` under
 * the guild's lock, so they commit in `seq` order; reads run in one snapshot. Each race runs a few
 * rounds in varied orders and asserts only what holds in every order: no duplicate and no missing
 * `seq`, each author's lines in the order they sent them, a poller that never skips a line, pages
 * that join up exactly, and a kicked member who never reads or writes a line after the kick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { auditLog, guildMessages } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const POSTERS = 8;
const EACH = 6;
const ROUNDS = 3;

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 11 + round * 37;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Line {
  id: string;
  seq: number;
  text: string | null;
  author: { handle: string } | null;
}
interface ChatBody {
  messages: Line[];
  next: number;
  hasOlder: boolean;
  more: boolean;
}

describe.skipIf(!url)('real PostgreSQL: guild chat races safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: POSTERS * 3 + 4 });
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

  async function guildOf(n: number) {
    const leader = await account();
    const members = await Promise.all(Array.from({ length: n }, account));
    const guild = await insertGuild(db(), leader.id, {
      members: members.map((m) => ({ accountId: m.id })),
    });
    return { guild, leader, members };
  }

  async function seqsOf(guildId: string) {
    return db()
      .select({ id: guildMessages.id, seq: guildMessages.seq })
      .from(guildMessages)
      .where(eq(guildMessages.guildId, guildId))
      .orderBy(asc(guildMessages.seq));
  }

  it('concurrent posts: no duplicates, no gaps, stable cursor order, a poller misses nothing', async () => {
    const retriesBefore = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, leader, members } = await guildOf(POSTERS);
      let posting = true;
      const polled: Line[] = [];
      const poller = (async () => {
        let since = 0;
        for (;;) {
          const stop = !posting;
          const res = await call(leader, 'GET', `/api/guild/chat?since=${since}`);
          expect(res.statusCode).toBe(200);
          const body = res.json<ChatBody>();
          for (let i = 0; i < body.messages.length; i++) {
            expect(body.messages[i]!.seq).toBeGreaterThan(i ? body.messages[i - 1]!.seq : since);
          }
          polled.push(...body.messages);
          since = body.next;
          if (stop && !body.more) break;
        }
      })();
      // Each poster sends its lines one after another; the posters run at once, in varied order.
      await Promise.all(
        shuffled(members, round).map(async (m, k) => {
          for (let i = 0; i < EACH; i++) {
            const res = await call(m, 'POST', '/api/guild/chat', { text: `p${k} line ${i}` });
            expect(res.statusCode, res.body).toBe(201);
          }
        }),
      );
      posting = false;
      await poller;

      const rows = await seqsOf(guild.id);
      const total = POSTERS * EACH;
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      // The poller saw every line exactly once, in `seq` order.
      expect(polled.map((l) => l.id)).toEqual(rows.map((r) => r.id));

      // Each author's lines are in the order they sent them, whatever the interleaving.
      const byAuthor = new Map<string, string[]>();
      for (const l of polled) {
        const list = byAuthor.get(l.author!.handle) ?? [];
        list.push(l.text!);
        byAuthor.set(l.author!.handle, list);
      }
      for (const texts of byAuthor.values()) {
        const k = texts[0]!.split(' ')[0];
        expect(texts).toEqual(Array.from({ length: EACH }, (_, i) => `${k} line ${i}`));
      }

      // Paging back from the newest page joins up exactly.
      const paged: Line[] = [];
      let before: number | undefined;
      for (;;) {
        const body = (
          await call(members[0]!, 'GET', `/api/guild/chat${before ? `?before=${before}` : ''}`)
        ).json<ChatBody>();
        paged.unshift(...body.messages);
        if (!body.hasOlder) break;
        before = body.messages[0]!.seq;
      }
      expect(paged.map((l) => l.id)).toEqual(rows.map((r) => r.id));
    }
    expect(transactionStats.retries).toBe(retriesBefore);
  }, 120_000);

  it('a poll and posts racing a kick never reach past the kick', async () => {
    const retriesBefore = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, leader, members } = await guildOf(4);
      const [target, ...others] = members as [TestAccount, ...TestAccount[]];
      await call(others[0]!, 'POST', '/api/guild/chat', { text: 'opening line' });
      const reads: { status: number; seqs: number[] }[] = [];
      const posts: { status: number; seq: number | null }[] = [];
      let othersPosted = 0;
      let kicked = false;
      let done = false;
      // The target polls and posts without pause until the others are done; the others post
      // steadily; the leader kicks the target part-way through (later in each round).
      const reader = async (withCursor: boolean) => {
        while (!done) {
          const res = await call(target, 'GET', `/api/guild/chat${withCursor ? '?since=0' : ''}`);
          reads.push({
            status: res.statusCode,
            seqs: res.statusCode === 200 ? res.json<ChatBody>().messages.map((m) => m.seq) : [],
          });
        }
      };
      const writer = async () => {
        for (let i = 0; !done; i++) {
          const res = await call(target, 'POST', '/api/guild/chat', { text: `mine ${i}` });
          posts.push({
            status: res.statusCode,
            seq: res.statusCode === 201 ? res.json<{ message: Line }>().message.seq : null,
          });
        }
      };
      const kickAfter = 4 + round * 5;
      const poster = async (o: TestAccount) => {
        for (let i = 0; i < 12; i++) {
          const res = await call(o, 'POST', '/api/guild/chat', { text: `theirs ${i}` });
          expect(res.statusCode).toBe(201);
          othersPosted += 1;
          if (!kicked && othersPosted >= kickAfter) {
            kicked = true;
            const kick = await call(leader, 'POST', `/api/guild/members/${target.handle}/kick`);
            expect(kick.statusCode).toBe(200);
          }
        }
      };
      const tasks = shuffled(
        [() => reader(false), () => reader(true), () => reader(false), writer],
        round,
      ).map((t) => t());
      await Promise.all(others.map(poster));
      done = true;
      await Promise.all(tasks);
      expect(reads.some((r) => r.status === 200)).toBe(true);
      expect(reads.some((r) => r.status === 404)).toBe(true);

      const [kick] = await db()
        .select({ data: auditLog.data })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.event, 'guild.kick'),
            sql`${auditLog.data}->>'target' = ${target.id}`,
            sql`${auditLog.data}->>'guildId' = ${guild.id}`,
          ),
        );
      const boundary = (kick!.data as { chatSeq: number }).chatSeq;
      for (const r of reads) {
        expect([200, 404]).toContain(r.status);
        for (const s of r.seqs) expect(s).toBeLessThanOrEqual(boundary);
      }
      for (const p of posts) {
        expect([201, 404]).toContain(p.status);
        if (p.seq !== null) expect(p.seq).toBeLessThanOrEqual(boundary);
      }
      // After the kick: nothing at all.
      expect((await call(target, 'GET', '/api/guild/chat')).statusCode).toBe(404);
      const rows = await seqsOf(guild.id);
      expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
      expect(rows.length).toBe(1 + 12 * others.length + posts.filter((p) => p.seq).length);
    }
    expect(transactionStats.retries).toBe(retriesBefore);
  }, 120_000);
});
