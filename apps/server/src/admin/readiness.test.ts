/**
 * Ticket 8.6: the admin panel's Readiness tab. The permission matrix, every item's states
 * (configured, unconfigured, partial), the privacy checklist (stored, versioned, audited), the test
 * letter (captured by the test transport; the typed address is in no table, no log line and no
 * response; its own rate limit), a guard that no secret value is in any answer, and the backup
 * status file (missing, old, fresh, unreadable) with an injected clock.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_TRADING_SETTINGS,
  GAME_VERSION,
  type TradingSettings,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  accounts,
  auditLog,
  gameSettings,
  reservedNames,
  seasons,
  worldEvents,
} from '../db/schema.js';
import { queryRows } from '../db/query.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { SESSION_COOKIE } from '../auth/routes.js';
import {
  DISABLED_MAILER,
  createLogMailer,
  createMemoryMailer,
  createSmtpMailer,
  type Mailer,
} from '../mail/mailer.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import {
  BACKUP_FRESH_MS,
  PRIVACY_CHECK_IDS,
  backupItem,
  emailItem,
  eventItem,
  parseBackupStatus,
  privacyItem,
  readBackupStatus,
  reservedNamesItem,
  seasonItem,
  sharedStateItem,
  testAccountsItem,
  tradingItem,
  tradingLaunchStep,
  deployItem,
  type LegalFileState,
} from './readiness.js';

type Who = 'anonymous' | 'player' | 'moderator' | 'admin';
const WHO: Who[] = ['anonymous', 'player', 'moderator', 'admin'];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function settings(patch: (s: TradingSettings) => void): TradingSettings {
  const s = structuredClone(DEFAULT_TRADING_SETTINGS) as TradingSettings;
  patch(s);
  return s;
}

const statusOf = (body: { items: { id: string; status: string }[] }, id: string) =>
  body.items.find((i) => i.id === id)!.status;

// ---- Pure item rules ------------------------------------------------------------------------

describe('readiness items (pure)', () => {
  const now = new Date('2030-03-01T12:00:00Z');

  it('email: not set without a transport, attention in dev/test, done after a sent letter', () => {
    expect(emailItem(DISABLED_MAILER, null).status).toBe('not_set');
    expect(emailItem(createMemoryMailer(), null).status).toBe('attention');
    expect(
      emailItem(
        createLogMailer(() => undefined),
        null,
      ).status,
    ).toBe('attention');
    const smtp = { transport: 'smtp', enabled: true, send: () => Promise.resolve() } as Mailer;
    expect(emailItem(smtp, null).status).toBe('attention');
    expect(emailItem(smtp, { at: now, outcome: 'failed' }).status).toBe('attention');
    expect(emailItem(smtp, { at: now, outcome: 'sent' }).status).toBe('done');
  });

  it('privacy: not set, partial and done', () => {
    const files = (present: boolean, template = false): LegalFileState[] => [
      { page: 'impressum', present, template },
      { page: 'datenschutz', present, template },
    ];
    const ticks = (n: number) => ({
      ticked: PRIVACY_CHECK_IDS.slice(0, n),
      version: n,
      updatedAt: null,
    });
    expect(privacyItem(files(false), ticks(0)).status).toBe('not_set');
    expect(privacyItem(files(false), ticks(2)).status).toBe('attention');
    expect(privacyItem(files(true, true), ticks(PRIVACY_CHECK_IDS.length)).status).toBe(
      'attention',
    );
    expect(privacyItem(files(true), ticks(3)).status).toBe('attention');
    expect(privacyItem(files(true), ticks(PRIVACY_CHECK_IDS.length)).status).toBe('done');
  });

  it('season: none, scheduled, running, only past; names the waiting formula switches', () => {
    const s1 = {
      number: 1,
      startsAt: new Date(now.getTime() + DAY),
      endsAt: new Date(now.getTime() + 57 * DAY),
    };
    expect(seasonItem({ current: null, next: null, past: 0, waiting: [] }).status).toBe('not_set');
    expect(seasonItem({ current: null, next: null, past: 1, waiting: [] }).status).toBe(
      'attention',
    );
    expect(seasonItem({ current: null, next: s1, past: 0, waiting: [] }).status).toBe('done');
    const running = seasonItem({
      current: s1,
      next: null,
      past: 0,
      waiting: [{ metric: 'power', from: 1, to: 2, afterSeason: 1, plannedAt: now.toISOString() }],
    });
    expect(running.status).toBe('done');
    expect(running.summary).toMatch(/switch in at the end of the season under way/);
    expect(running.facts.map((f) => f.value)).toContain('Power 1 → 2 after Season 1');
  });

  it('event: none, scheduled, under way, only past', () => {
    const e = { number: 1, definitionId: 'harvestOfBones', startsAt: now, endsAt: now };
    expect(eventItem({ current: null, next: null, past: 0 }).status).toBe('not_set');
    expect(eventItem({ current: null, next: null, past: 2 }).status).toBe('attention');
    expect(eventItem({ current: null, next: e, past: 0 }).status).toBe('done');
    expect(eventItem({ current: e, next: null, past: 0 }).status).toBe('done');
  });

  it('trading: every step of the launch order, and switches out of order', () => {
    expect(tradingLaunchStep(DEFAULT_TRADING_SETTINGS)).toEqual({
      step: 0,
      outOfOrder: [],
      lastGroup: { on: 0, of: 4 },
    });
    const one = settings((s) => {
      s.trading = true;
      s.trade.items = true;
      s.shelf.items = true;
    });
    expect(tradingLaunchStep(one).step).toBe(1);
    const two = settings((s) => {
      Object.assign(s, one);
      s.trade = { ...one.trade, materials: true };
      s.shelf = { ...one.shelf, materials: true };
    });
    expect(tradingLaunchStep(two).step).toBe(2);
    const three = settings((s) => {
      Object.assign(s, structuredClone(two));
      s.tradeable.mythic = true;
    });
    expect(tradingLaunchStep(three)).toMatchObject({
      step: 3,
      outOfOrder: [],
      lastGroup: { on: 1 },
    });
    const four = settings((s) => {
      Object.assign(s, structuredClone(two));
      s.trade.gold = true;
      s.shelf.gold = true;
      s.tradeable.mythic = true;
      s.tradeable.void = true;
      s.tradeable.prismatic = true;
    });
    expect(tradingLaunchStep(four).step).toBe(4);
    const early = settings((s) => {
      Object.assign(s, structuredClone(one));
      s.trade.gold = true;
    });
    expect(tradingLaunchStep(early)).toMatchObject({ step: 1, outOfOrder: ['gold'] });

    expect(tradingItem(DEFAULT_TRADING_SETTINGS, true).status).toBe('not_set');
    expect(tradingItem(one, true).status).toBe('done');
    expect(tradingItem(one, false).status).toBe('attention');
    expect(tradingItem(early, true).status).toBe('attention');
    // The master switch on without items is ahead of the order too.
    expect(
      tradingItem(
        settings((s) => (s.trading = true)),
        true,
      ).status,
    ).toBe('attention');
  });

  it('reserved names, test accounts, deploy and shared state', () => {
    expect(reservedNamesItem(0).status).toBe('not_set');
    expect(reservedNamesItem(2).status).toBe('done');
    expect(testAccountsItem(0).status).toBe('not_set');
    expect(testAccountsItem(1).status).toBe('done');
    expect(testAccountsItem(0).summary).toMatch(/never switch a test account back to normal/i);
    expect(deployItem({ gitSha: null, buildTime: null }).status).toBe('attention');
    const d = deployItem({ gitSha: 'abc1234', buildTime: '2030-01-01T00:00:00Z' });
    expect(d.status).toBe('done');
    expect(d.facts.map((f) => f.value)).toEqual([GAME_VERSION, 'abc1234', '2030-01-01T00:00:00Z']);
    expect(sharedStateItem('postgres').status).toBe('done');
    expect(sharedStateItem('memory').status).toBe('attention');
  });
});

// ---- Backup status file ---------------------------------------------------------------------

describe('backup status file', () => {
  const now = new Date('2030-03-01T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const file = (finishedAt: string, bytes = 123_456) => JSON.stringify({ finishedAt, bytes });

  it('fresh within the window, old after it, with an injected clock', () => {
    const fresh = parseBackupStatus(file(at(3 * HOUR)), now);
    expect(fresh).toMatchObject({ state: 'fresh', bytes: 123_456, ageMs: 3 * HOUR });
    expect(backupItem(fresh).status).toBe('done');
    expect(parseBackupStatus(file(at(BACKUP_FRESH_MS)), now).state).toBe('fresh');
    const old = parseBackupStatus(file(at(BACKUP_FRESH_MS + 60_000)), now);
    expect(old.state).toBe('old');
    expect(backupItem(old).status).toBe('attention');
  });

  it('anything but the two fields in their shape is unreadable', () => {
    for (const text of [
      '',
      'not json',
      '[]',
      'null',
      JSON.stringify({ finishedAt: 'yesterday', bytes: 1 }),
      JSON.stringify({ finishedAt: at(HOUR) }),
      JSON.stringify({ finishedAt: at(HOUR), bytes: -1 }),
      JSON.stringify({ finishedAt: at(HOUR), bytes: '12' }),
      // A time well in the future is not a real run.
      JSON.stringify({ finishedAt: at(-2 * DAY), bytes: 1 }),
    ]) {
      expect(parseBackupStatus(text, now).state, text).toBe('unreadable');
    }
    expect(backupItem({ state: 'unreadable' }).status).toBe('attention');
  });

  it('reads the file: not configured, missing, too big, fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-backup-'));
    try {
      expect(await readBackupStatus(undefined, now)).toEqual({ state: 'not_configured' });
      expect(backupItem({ state: 'not_configured' }).status).toBe('not_set');
      expect(await readBackupStatus(join(dir, 'backup.json'), now)).toEqual({ state: 'missing' });
      expect(backupItem({ state: 'missing' }).status).toBe('not_set');
      await writeFile(join(dir, 'big.json'), 'x'.repeat(5000));
      expect((await readBackupStatus(join(dir, 'big.json'), now)).state).toBe('unreadable');
      await writeFile(join(dir, 'backup.json'), file(at(HOUR)));
      expect((await readBackupStatus(join(dir, 'backup.json'), now)).state).toBe('fresh');
      expect((await readBackupStatus(dir, now)).state).toBe('unreadable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- Through the API ------------------------------------------------------------------------

describe('readiness API', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let tmp: string;
  const who = {} as Record<Exclude<Who, 'anonymous'>, TestAccount>;
  const mailer = createMemoryMailer();
  const logs: string[] = [];
  const ADDRESS = 'keeper.private-inbox-7731@owner-mail.example';

  const inject = (
    w: TestAccount | null,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers,
      ...(w ? { cookies: { [SESSION_COOKIE]: w.token } } : {}),
    });
  const read = async () => {
    const res = await inject(who.admin, 'GET', '/api/admin/readiness');
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const tick = (expectedVersion: number, ticked: string[]) =>
    inject(
      who.admin,
      'PUT',
      '/api/admin/readiness/privacy',
      { expectedVersion, ticked },
      { 'idempotency-key': uuidv7() },
    );

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'wf-readiness-'));
    database = await createTestDatabase();
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(chunk.toString('utf8'));
        done();
      },
    });
    app = buildApp({
      database,
      logger: { level: 'trace', stream },
      auth: { mailer },
      legal: { dir: join(tmp, 'legal') },
      admin: {
        build: { gitSha: 'abc1234', buildTime: '2026-11-06T10:00:00Z' },
        backupStatusFile: join(tmp, 'status', 'backup.json'),
        testLetterLimit: { max: 3, windowMs: HOUR },
      },
    });
    await app.ready();
    who.player = await insertAccount(database.db, { name: 'Plain Pell' });
    who.moderator = await insertAccount(database.db, { role: 'moderator', name: 'Warden Brann' });
    who.admin = await insertAccount(database.db, { role: 'admin', name: 'Castellan Ysolde' });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  describe('permission matrix', () => {
    const ROUTES = [
      { method: 'GET' as const, url: '/api/admin/readiness', ok: 200 },
      {
        method: 'PUT' as const,
        url: '/api/admin/readiness/privacy',
        payload: { expectedVersion: 0, ticked: [] },
        ok: 200,
      },
      {
        method: 'POST' as const,
        url: '/api/admin/readiness/test-letter',
        payload: { to: 'matrix@example.test' },
        ok: 200,
      },
    ];
    for (const route of ROUTES) {
      for (const w of WHO) {
        const expected = w === 'admin' ? route.ok : 404;
        it(`${w} × ${route.method} ${route.url} → ${expected}`, async () => {
          const actor = w === 'anonymous' ? null : who[w];
          const res = await inject(actor, route.method, route.url, route.payload, {
            'idempotency-key': uuidv7(),
          });
          expect(res.statusCode).toBe(expected);
          if (expected === 404) expect(res.json().error.code).toBe('not_found');
        });
      }
    }
  });

  it('a fresh server: what is not set yet', async () => {
    const body = await read();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([
      'email',
      'privacy',
      'reservedNames',
      'testAccounts',
      'season',
      'event',
      'trading',
      'backups',
      'deploy',
      'sharedState',
    ]);
    // The memory transport is a test capture, not real mail.
    expect(statusOf(body, 'email')).toBe('attention');
    expect(statusOf(body, 'privacy')).toBe('not_set');
    expect(statusOf(body, 'reservedNames')).toBe('not_set');
    expect(statusOf(body, 'testAccounts')).toBe('not_set');
    expect(statusOf(body, 'season')).toBe('not_set');
    expect(statusOf(body, 'event')).toBe('not_set');
    expect(statusOf(body, 'trading')).toBe('not_set');
    expect(statusOf(body, 'backups')).toBe('not_set');
    expect(statusOf(body, 'deploy')).toBe('done');
    expect(statusOf(body, 'sharedState')).toBe('attention');
    expect(body.testLetter).toEqual({ available: true });
    // Every item links somewhere: an admin tab that exists (web ADMIN_SECTIONS) or a doc heading.
    const TABS = [
      'readiness',
      'invites',
      'players',
      'inspect',
      'world',
      'telemetry',
      'seasons',
      'events',
      'trading',
      'trades',
      'status',
      'roles',
      'names',
      'animations',
    ];
    for (const item of body.items) {
      expect(item.links.length).toBeGreaterThan(0);
      for (const l of item.links) {
        if (l.kind === 'tab') expect(TABS).toContain(l.section);
        else expect(l.path).toMatch(/^docs\/[A-Z_]+\.md$/);
      }
    }
    const views = await database.db.select().from(auditLog).where(eq(auditLog.event, 'admin.view'));
    expect(views.some((r) => (r.data as { section?: string }).section === 'readiness')).toBe(true);
  });

  it('the privacy checklist: ticks are stored, versioned and audited; a stale form is refused', async () => {
    const start = (await read()).privacy;
    const v0 = start.version;
    const first = await tick(v0, ['leaderboards', 'emails']);
    expect(first.statusCode).toBe(200);
    expect(first.json().privacy.version).toBe(v0 + 1);
    expect(
      first
        .json()
        .privacy.checklist.filter((c: { ticked: boolean }) => c.ticked)
        .map((c: { id: string }) => c.id),
    ).toEqual(['leaderboards', 'emails']);
    expect(statusOf(first.json(), 'privacy')).toBe('attention');
    expect((await tick(v0, ['provider'])).statusCode).toBe(409);
    // Unknown ids are refused by the schema.
    expect((await tick(v0 + 1, ['cookies'])).statusCode).toBe(400);
    // The same ticks again change nothing (no new version, no audit row).
    expect((await tick(v0 + 1, ['emails', 'leaderboards'])).json().privacy.version).toBe(v0 + 1);
    const rows = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'admin.readiness.privacy'));
    const mine = rows.filter((r) => (r.data as { version: number }).version === v0 + 1);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.accountId).toBe(who.admin.id);
    expect(mine[0]!.data).toMatchObject({ before: [], after: ['leaderboards', 'emails'] });
    // All ticked and the owner's files filled in: done.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmp, 'legal'), { recursive: true });
    await writeFile(join(tmp, 'legal', 'impressum.md'), '# Impressum\n');
    await writeFile(
      join(tmp, 'legal', 'datenschutz.md'),
      '<!-- worldforge:template -->\n# Datenschutz\n',
    );
    const all = await tick(v0 + 1, [...PRIVACY_CHECK_IDS]);
    expect(statusOf(all.json(), 'privacy')).toBe('attention');
    await writeFile(join(tmp, 'legal', 'datenschutz.md'), '# Datenschutz\n');
    expect(statusOf(await read(), 'privacy')).toBe('done');
  });

  it('configured state: season, event, names, test accounts, trading, backups', async () => {
    const t = Date.now();
    await database.db.insert(seasons).values({
      number: 1,
      startsAt: new Date(t - DAY),
      endsAt: new Date(t + 55 * DAY),
    });
    await database.db.insert(worldEvents).values({
      number: 1,
      definitionId: 'harvestOfBones',
      startsAt: new Date(t + 3 * DAY),
      endsAt: new Date(t + 10 * DAY),
      createdAt: new Date(t),
    });
    await database.db.insert(reservedNames).values({
      id: uuidv7(),
      name: 'Ysolde',
      skeleton: 'ysolde',
      note: '',
      createdAt: new Date(t),
    } as typeof reservedNames.$inferInsert);
    const tester = await insertAccount(database.db, { name: 'Testing Tamsin' });
    await database.db.update(accounts).set({ isTest: true }).where(eq(accounts.id, tester.id));
    const opened = settings((s) => {
      s.trading = true;
      s.trade.items = true;
      s.shelf.items = true;
    });
    await database.db.insert(gameSettings).values({
      key: 'trading',
      value: opened as unknown as Record<string, unknown>,
      version: 1,
      updatedAt: new Date(t),
    });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmp, 'status'), { recursive: true });
    await writeFile(
      join(tmp, 'status', 'backup.json'),
      JSON.stringify({ finishedAt: new Date(t - 2 * HOUR).toISOString(), bytes: 2_400_000 }),
    );
    const body = await read();
    expect(statusOf(body, 'season')).toBe('done');
    expect(statusOf(body, 'event')).toBe('done');
    expect(statusOf(body, 'reservedNames')).toBe('done');
    expect(statusOf(body, 'testAccounts')).toBe('done');
    expect(statusOf(body, 'trading')).toBe('done');
    const trading = body.items.find((i: { id: string }) => i.id === 'trading');
    expect(trading.facts[0].value).toMatch(/^Step 1 of 3/);
    expect(statusOf(body, 'backups')).toBe('done');
    // An old backup needs attention.
    await writeFile(
      join(tmp, 'status', 'backup.json'),
      JSON.stringify({ finishedAt: new Date(t - 3 * DAY).toISOString(), bytes: 2_400_000 }),
    );
    expect(statusOf(await read(), 'backups')).toBe('attention');
  });

  it('the test letter: sent through the transport, the address stored and logged nowhere', async () => {
    const before = mailer.outbox.length;
    const res = await inject(who.admin, 'POST', '/api/admin/readiness/test-letter', {
      to: ADDRESS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'sent', code: null });
    expect(res.body).not.toContain(ADDRESS);
    expect(mailer.outbox.length).toBe(before + 1);
    const letter = mailer.last(ADDRESS, 'test_letter')!;
    expect(letter.subject).toBe('Worldforge test letter');
    expect(letter.text).not.toContain(who.admin.displayName);
    // The board shows the last test letter without the address.
    const board = await read();
    const email = board.items.find((i: { id: string }) => i.id === 'email');
    expect(
      email.facts.find((f: { label: string }) => f.label === 'Last test letter').value,
    ).toMatch(/^Sent · /);
    expect(JSON.stringify(board)).not.toContain(ADDRESS);
    // Audit row: outcome only.
    const [row] = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'admin.readiness.test_letter'));
    expect(row!.accountId).toBe(who.admin.id);
    // Every table, every row, as text: the address is nowhere (audit, telemetry, idempotency…).
    const tables = await queryRows<{ name: string }>(
      database.db,
      sql`select table_name as name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(tables.length).toBeGreaterThan(20);
    const lower = ADDRESS.toLowerCase();
    for (const { name } of tables) {
      const hits = await queryRows<{ n: number }>(
        database.db,
        sql`select count(*)::int as n from ${sql.identifier(name)} t where lower(t::text) like ${`%${lower}%`}`,
      );
      expect(hits[0]!.n, name).toBe(0);
    }
    // The log never carries it (the logger runs at trace, so request logs are all here).
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n').toLowerCase()).not.toContain(lower);
    // Telemetry counted it by kind and outcome.
    const tele = await queryRows<{ n: number }>(
      database.db,
      sql`select count(*)::int as n from telemetry_daily where metric = 'mail.send' and dim1 = 'test_letter' and dim2 = 'sent'`,
    );
    expect(tele[0]!.n).toBeGreaterThan(0);
  });

  it('a malformed address is refused without sending or counting', async () => {
    const before = mailer.outbox.length;
    for (const to of ['no-at-sign', 'two words@example.com', 'a@b']) {
      const res = await inject(who.admin, 'POST', '/api/admin/readiness/test-letter', { to });
      expect(res.statusCode, to).toBe(400);
      expect(res.body).not.toContain(to);
    }
    expect(mailer.outbox.length).toBe(before);
  });

  it('the test letter has its own limit per admin', async () => {
    const other = await insertAccount(database.db, { role: 'admin', name: 'Steward Odo' });
    const send = () =>
      inject(other, 'POST', '/api/admin/readiness/test-letter', { to: 'limit@example.test' });
    for (let i = 0; i < 3; i++) expect((await send()).statusCode).toBe(200);
    const refused = await send();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.details.limit).toBe('test_letter');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a transport failure is reported with the code only, and audited as failed', async () => {
    const failing: Mailer = {
      transport: 'smtp',
      enabled: true,
      send: () =>
        Promise.reject(
          Object.assign(new Error(`550 mailbox unavailable: ${ADDRESS}`), {
            code: 'EENVELOPE',
            responseCode: 550,
            command: 'RCPT TO',
          }),
        ),
    };
    const db2 = await createTestDatabase();
    const lines: string[] = [];
    const app2 = buildApp({
      database: db2,
      logger: {
        level: 'trace',
        stream: new Writable({
          write(c: Buffer, _e, d) {
            lines.push(c.toString());
            d();
          },
        }),
      },
      auth: { mailer: failing },
    });
    try {
      await app2.ready();
      const a = await insertAccount(db2.db, { role: 'admin', name: 'Reeve Corvin' });
      const res = await app2.inject({
        method: 'POST',
        url: '/api/admin/readiness/test-letter',
        payload: { to: ADDRESS },
        cookies: { [SESSION_COOKIE]: a.token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'failed', code: '550' });
      expect(res.body).not.toContain(ADDRESS);
      expect(lines.join('\n')).not.toContain(ADDRESS);
      expect(lines.join('\n')).toContain('test letter failed');
      const [row] = await db2.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'admin.readiness.test_letter'));
      expect(row!.data).toMatchObject({ outcome: 'failed', code: '550' });
      expect(JSON.stringify(row!.data)).not.toContain(ADDRESS);
      const board = await app2.inject({
        method: 'GET',
        url: '/api/admin/readiness',
        cookies: { [SESSION_COOKIE]: a.token },
      });
      expect(statusOf(board.json(), 'email')).toBe('attention');
    } finally {
      await app2.close();
      await db2.close();
    }
  });

  it('without mail the test letter is unavailable', async () => {
    const db2 = await createTestDatabase();
    const app2 = buildApp({ database: db2 });
    try {
      await app2.ready();
      const a = await insertAccount(db2.db, { role: 'admin', name: 'Reeve Mabli' });
      const res = await app2.inject({
        method: 'POST',
        url: '/api/admin/readiness/test-letter',
        payload: { to: 'nobody@example.test' },
        cookies: { [SESSION_COOKIE]: a.token },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('email_unavailable');
      const board = await app2.inject({
        method: 'GET',
        url: '/api/admin/readiness',
        cookies: { [SESSION_COOKIE]: a.token },
      });
      expect(statusOf(board.json(), 'email')).toBe('not_set');
      expect(board.json().testLetter.available).toBe(false);
    } finally {
      await app2.close();
      await db2.close();
    }
  });

  it('guard: no secret value is in any answer (SMTP settings, legal text, backup file)', async () => {
    const SECRET = {
      host: 'smtp.secret-host-4471.example',
      user: 'secret-user-8812',
      pass: 'secret-pass-Zq93!x',
      from: 'Worldforge <no-reply@secret-sender-5520.example>',
    };
    const dir = await mkdtemp(join(tmpdir(), 'wf-guard-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'legal'));
    await writeFile(
      join(dir, 'legal', 'impressum.md'),
      '# Impressum\nOwner Street 99, secret-legal-text-3318\n',
    );
    await writeFile(
      join(dir, 'legal', 'datenschutz.md'),
      '# Datenschutz\nsecret-legal-text-3318\n',
    );
    await writeFile(
      join(dir, 'backup.json'),
      JSON.stringify({
        finishedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        bytes: 10,
        path: '/secret/backup-path-6630',
      }),
    );
    // A real SMTP mailer (it connects only when sending; nothing is sent here).
    const smtp = createSmtpMailer({
      host: SECRET.host,
      port: 587,
      secure: false,
      user: SECRET.user,
      pass: SECRET.pass,
      from: SECRET.from,
    });
    const db2 = await createTestDatabase();
    const app2 = buildApp({
      database: db2,
      auth: { mailer: smtp },
      legal: { dir: join(dir, 'legal') },
      admin: { backupStatusFile: join(dir, 'backup.json') },
    });
    try {
      await app2.ready();
      const a = await insertAccount(db2.db, { role: 'admin', name: 'Reeve Hale' });
      const answers = [
        await app2.inject({
          method: 'GET',
          url: '/api/admin/readiness',
          cookies: { [SESSION_COOKIE]: a.token },
        }),
        await app2.inject({
          method: 'PUT',
          url: '/api/admin/readiness/privacy',
          payload: { expectedVersion: 0, ticked: ['leaderboards'] },
          headers: { 'idempotency-key': uuidv7() },
          cookies: { [SESSION_COOKIE]: a.token },
        }),
        await app2.inject({
          method: 'GET',
          url: '/api/admin/status',
          cookies: { [SESSION_COOKIE]: a.token },
        }),
      ];
      const accountEmails = (await db2.db.select({ e: accounts.email }).from(accounts)).map(
        (r) => r.e,
      );
      expect(accountEmails.length).toBeGreaterThan(0);
      for (const res of answers) {
        expect(res.statusCode).toBe(200);
        for (const secret of [
          SECRET.host,
          SECRET.user,
          SECRET.pass,
          'secret-sender-5520',
          'secret-legal-text-3318',
          'Owner Street',
          'backup-path-6630',
          dir,
          ...accountEmails,
        ]) {
          expect(res.body, secret).not.toContain(secret);
        }
      }
      const body = answers[0]!.json();
      expect(statusOf(body, 'email')).toBe('attention');
      expect(statusOf(body, 'backups')).toBe('done');
      expect(body.items.find((i: { id: string }) => i.id === 'email').facts[0].value).toBe(
        'SMTP (your provider)',
      );
    } finally {
      await app2.close();
      await db2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- Doc links ------------------------------------------------------------------------------

describe('readiness doc links', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  /** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
  const slug = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\- ]/gu, '')
      .replace(/ /g, '-');

  it('every doc link points at a heading that exists', async () => {
    const items = [
      emailItem(DISABLED_MAILER, null),
      privacyItem(
        [
          { page: 'impressum', present: false, template: false },
          { page: 'datenschutz', present: false, template: false },
        ],
        { ticked: [], version: 0, updatedAt: null },
      ),
      reservedNamesItem(0),
      testAccountsItem(0),
      seasonItem({ current: null, next: null, past: 0, waiting: [] }),
      eventItem({ current: null, next: null, past: 0 }),
      tradingItem(DEFAULT_TRADING_SETTINGS, false),
      backupItem({ state: 'missing' }),
      deployItem({ gitSha: null, buildTime: null }),
      sharedStateItem('memory'),
    ];
    let checked = 0;
    for (const item of items) {
      for (const l of item.links) {
        if (l.kind !== 'doc') continue;
        const text = await readFile(join(root, l.path), 'utf8');
        const anchors = text
          .split('\n')
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) => slug(line.replace(/^#+ /, '')));
        expect(anchors, `${l.path}#${l.anchor}`).toContain(l.anchor);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(8);
  });
});
