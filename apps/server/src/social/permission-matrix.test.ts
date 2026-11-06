/**
 * Permission matrix (ticket 4.1, docs/SOCIAL.md "Roles"): every account role × every moderation
 * action, through the HTTP API, including acting on oneself, on another moderator and on an admin.
 * The expected table is written out by hand, so a rule change has to change it here too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { MODERATION_ACTIONS, type AccountRole, type ModerationAction } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { reports, sanctions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';

type Subject = 'self' | 'player' | 'moderator' | 'admin';
const SUBJECTS: Subject[] = ['self', 'player', 'moderator', 'admin'];
const ACTORS: AccountRole[] = ['player', 'moderator', 'admin'];

const ALLOW = 200;
const HIDDEN = 404; // not staff: the route does not exist for them
const FORBID = 403; // staff, but out of reach

/** Expected status for an action on a subject (every action but viewQueue). */
const EXPECTED: Record<AccountRole, Record<Subject, number>> = {
  player: { self: HIDDEN, player: HIDDEN, moderator: HIDDEN, admin: HIDDEN },
  moderator: { self: FORBID, player: ALLOW, moderator: FORBID, admin: FORBID },
  admin: { self: FORBID, player: ALLOW, moderator: ALLOW, admin: FORBID },
};
const EXPECTED_QUEUE: Record<AccountRole, number> = {
  player: HIDDEN,
  moderator: ALLOW,
  admin: ALLOW,
};

describe('moderation permission matrix', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  let reporter: TestAccount;
  const actors = {} as Record<AccountRole, TestAccount>;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] } },
    });
    await app.ready();
    call = caller(app);
    reporter = await insertAccount(database.db);
    for (const role of ACTORS) actors[role] = await insertAccount(database.db, { role });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function subjectFor(actor: TestAccount, s: Subject): Promise<TestAccount> {
    return s === 'self' ? actor : insertAccount(database.db, { role: s });
  }

  async function openReport(subject: TestAccount, action: ModerationAction): Promise<string> {
    const target =
      action === 'hideContent'
        ? { kind: 'profileField', handle: subject.handle, field: 'displayName' }
        : { kind: 'player', handle: subject.handle };
    const res = await call(reporter, 'POST', '/api/reports', { target, reason: 'other' });
    if (res.statusCode === 201) return res.json().report.id;
    // Self cases reuse the actor, so the open report from an earlier case is still there.
    expect(res.json().error.code).toBe('report_open');
    return res.json().error.details.reportId;
  }

  async function perform(actor: TestAccount, action: ModerationAction, subject: TestAccount) {
    if (action === 'liftSanction') {
      const id = uuidv7();
      await database.db.insert(sanctions).values({
        id,
        subjectId: subject.id,
        kind: 'mute',
        reason: 'Matrix test',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const res = await call(actor, 'POST', `/api/mod/sanctions/${id}/lift`, {
        reason: 'Matrix test',
      });
      const [row] = await database.db.select().from(sanctions).where(eq(sanctions.id, id));
      return { res, changed: row!.liftedAt !== null };
    }
    const reportId = await openReport(subject, action);
    const body =
      action === 'dismissReport'
        ? { action: 'dismiss' }
        : { action, reason: 'Matrix test', durationHours: 24 };
    const res = await call(actor, 'POST', `/api/mod/reports/${reportId}/resolve`, body);
    const [row] = await database.db.select().from(reports).where(eq(reports.id, reportId));
    return { res, changed: row!.status !== 'open' };
  }

  for (const role of ACTORS) {
    it(`${role} → viewQueue`, async () => {
      expect((await call(actors[role], 'GET', '/api/mod/queue')).statusCode).toBe(
        EXPECTED_QUEUE[role],
      );
    });

    for (const action of MODERATION_ACTIONS.filter((a) => a !== 'viewQueue')) {
      for (const s of SUBJECTS) {
        it(`${role} → ${action} on ${s}`, async () => {
          const actor = actors[role];
          const subject = await subjectFor(actor, s);
          const { res, changed } = await perform(actor, action, subject);
          const want = EXPECTED[role][s];
          expect({
            status: res.statusCode,
            body: want === ALLOW ? null : res.json().error.code,
          }).toEqual({
            status: want,
            body: want === ALLOW ? null : want === HIDDEN ? 'not_found' : 'forbidden',
          });
          // Refused actions change nothing.
          expect(changed).toBe(want === ALLOW);
        });
      }
    }
  }
});
