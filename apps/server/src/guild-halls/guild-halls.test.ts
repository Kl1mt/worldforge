/**
 * Guild halls (ticket 8.4, docs/GUILD_HALLS.md): the permission matrix through the API, the
 * no-refund acknowledgement, the anti-monopoly caps (per account and UTC day, shared by its
 * heroes; no over-fill), buying and hanging upgrades, leaving and kicks (nothing refunded), the
 * disband forfeit, test accounts (D.4), reconciliation with the audit log, and invariance (5.1
 * scores and the character row unchanged). Dates derive from the wall clock.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { GUILD_HALL_UPGRADES, hallTotalPrice, treasuryCap } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  characterMaterials,
  characters,
  guildTreasuries,
  type Guild,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { setTestAccount } from '../admin/test-accounts.js';
import { dayFromNow, DAY } from '../test/guild-seasons.js';

describe('guild halls', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  let nowMs = dayFromNow(1).getTime() + 12 * 3_600_000;
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    call = caller(app);
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const post = (who: TestAccount, url: string, payload: object, key: string = randomUUID()) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'idempotency-key': key },
      cookies: { [SESSION_COOKIE]: who.token },
    });
  const status = (r: { statusCode: number; json: () => unknown }) =>
    r.statusCode < 300
      ? r.statusCode
      : `${r.statusCode} ${(r.json() as { error: { code: string } }).error.code}`;

  async function rich(who: TestAccount, gold = 1_000_000) {
    const hero = await insertCharacter(db(), who.id, { level: 30 });
    await db().update(characters).set({ gold }).where(eq(characters.id, hero.id));
    await db()
      .insert(characterMaterials)
      .values(
        (['timber', 'rawHide', 'ironOre', 'soulShard', 'abbeySilver'] as const).map(
          (materialId) => ({ characterId: hero.id, materialId, quantity: 1_000 }),
        ),
      );
    return hero;
  }
  const give = (
    who: TestAccount,
    characterId: string,
    offer: { resource: string; amount: number }[],
    ack = true,
  ) => post(who, '/api/guild/hall/contribute', { characterId, offer, acknowledgeNoRefund: ack });
  const goldOf = async (id: string) =>
    Number((await db().select().from(characters).where(eq(characters.id, id)))[0]!.gold);
  const treasury = async (g: Guild) =>
    (await db().select().from(guildTreasuries).where(eq(guildTreasuries.guildId, g.id)))[0];

  let leader: TestAccount, officer: TestAccount, member: TestAccount, outsider: TestAccount;
  let guild: Guild;
  let heroes: Record<string, string>;

  beforeAll(async () => {
    leader = await insertAccount(db());
    officer = await insertAccount(db());
    member = await insertAccount(db());
    outsider = await insertAccount(db());
    guild = await insertGuild(db(), leader.id, {
      members: [
        { accountId: officer.id, role: 'officer' },
        { accountId: member.id, role: 'member' },
      ],
    });
    heroes = {};
    for (const p of [leader, officer, member, outsider]) heroes[p.id] = (await rich(p)).id;
  });

  it('follows the permission matrix', async () => {
    const want: Record<string, Record<string, number | string>> = {
      view: { leader: 200, officer: 200, member: 200, outsider: '404 not_in_guild' },
      contribute: { leader: 200, officer: 200, member: 200, outsider: '404 not_in_guild' },
      buy: {
        leader: 200,
        officer: 200,
        member: '403 guild_forbidden',
        outsider: '404 not_in_guild',
      },
      display: {
        leader: 200,
        officer: 200,
        member: '403 guild_forbidden',
        outsider: '404 not_in_guild',
      },
    };
    const who = { leader, officer, member, outsider } as const;
    for (const [name, p] of Object.entries(who)) {
      expect(status(await call(p, 'GET', '/api/guild/hall')), `view ${name}`).toBe(
        want.view![name],
      );
      expect(
        status(await give(p, heroes[p.id]!, [{ resource: 'gold', amount: 6_000 }])),
        `contribute ${name}`,
      ).toBe(want.contribute![name]);
    }
    expect(
      status(await post(member, '/api/guild/hall/buy', { upgradeId: 'crest-frame.iron-rim' })),
    ).toBe(want.buy!.member);
    expect(
      status(await post(outsider, '/api/guild/hall/buy', { upgradeId: 'crest-frame.iron-rim' })),
    ).toBe(want.buy!.outsider);
    expect(status(await post(member, '/api/guild/hall/display', { crestFrame: null }))).toBe(
      want.display!.member,
    );
    expect(status(await post(outsider, '/api/guild/hall/display', { crestFrame: null }))).toBe(
      want.display!.outsider,
    );
    expect((await treasury(guild))!.gold).toBe(18_000);
  });

  it('shows the no-refund notice and refuses a gift without its acknowledgement', async () => {
    const hall = (await call(member, 'GET', '/api/guild/hall')).json();
    expect(hall.notice).toMatch(/never given back/);
    const before = await goldOf(heroes[member.id]!);
    expect(
      status(await give(member, heroes[member.id]!, [{ resource: 'gold', amount: 1 }], false)),
    ).toBe('422 no_refund_unacknowledged');
    expect(await goldOf(heroes[member.id]!)).toBe(before);
  });

  it('caps each account per UTC day, shared by its heroes, and takes the rest from nobody', async () => {
    const second = await rich(member);
    const cap = treasuryCap('gold');
    const before = await goldOf(heroes[member.id]!);
    const res = await give(member, heroes[member.id]!, [{ resource: 'gold', amount: cap }]);
    expect(res.statusCode, res.body).toBe(200);
    // 6,000 was given today already: the rest of the cap is taken, the remainder stays.
    expect(res.json().accepted).toEqual([{ resource: 'gold', amount: cap - 6_000 }]);
    expect(res.json().limited).toEqual({ gold: 'cap' });
    expect(await goldOf(heroes[member.id]!)).toBe(before - (cap - 6_000));
    expect(status(await give(member, second.id, [{ resource: 'gold', amount: 1 }]))).toBe(
      '409 treasury_capped',
    );
    // The other resources have their own caps.
    const silver = await give(member, second.id, [{ resource: 'abbeySilver', amount: 50 }]);
    expect(silver.json().accepted).toEqual([
      { resource: 'abbeySilver', amount: treasuryCap('abbeySilver') },
    ]);
    // A new UTC day: a fresh cap.
    nowMs += DAY;
    expect(status(await give(member, second.id, [{ resource: 'gold', amount: 100 }]))).toBe(200);
  });

  it('buys and hangs upgrades (leader or officer), once each, never past the treasury', async () => {
    const buy = (who: TestAccount, upgradeId: string) =>
      post(who, '/api/guild/hall/buy', { upgradeId });
    expect(status(await buy(officer, 'hall-banner.pale-silks'))).toBe('409 treasury_short');
    expect(status(await buy(officer, 'nope.nothing'))).toBe('422 unknown_upgrade');
    // Iron ore: a tenth of the hall's 290 a day per account, so three members fund the rim's 60.
    expect(status(await buy(officer, 'crest-frame.iron-rim'))).toBe('409 treasury_short');
    for (const p of [leader, officer, member])
      expect(status(await give(p, heroes[p.id]!, [{ resource: 'ironOre', amount: 29 }]))).toBe(200);
    const before = (await treasury(guild))!;
    const res = await buy(officer, 'crest-frame.iron-rim');
    expect(res.statusCode, res.body).toBe(200);
    const after = (await treasury(guild))!;
    expect(Number(after.gold)).toBe(Number(before.gold) - 6_000);
    expect(after.materials.ironOre ?? 0).toBe((before.materials.ironOre ?? 0) - 60);
    expect(status(await buy(leader, 'crest-frame.iron-rim'))).toBe('409 already_owned');
    const display = (body: object) => post(leader, '/api/guild/hall/display', body);
    expect(status(await display({ backdrop: 'crest-frame.iron-rim' }))).toBe('422 wrong_kind');
    expect(status(await display({ backdrop: 'backdrop.hearth-glow' }))).toBe('422 not_owned');
    const hung = await display({ crestFrame: 'crest-frame.iron-rim' });
    expect(hung.json().look).toMatchObject({ crestFrame: 'crest-frame.iron-rim', backdrop: null });
    // Shown to anyone who may see the guild.
    const pub = await call(outsider, 'GET', `/api/guilds/${guild.handle}/hall`);
    expect(pub.json().look.crestFrame).toBe('crest-frame.iron-rim');
    // Unhung.
    expect((await display({ crestFrame: null })).json().look.crestFrame).toBeNull();
  });

  it('never fills the treasury past what the hall still needs', async () => {
    const hall = (await call(leader, 'GET', '/api/guild/hall')).json();
    const room = hall.resources.find((r: { resource: string }) => r.resource === 'gold').room;
    const total = hallTotalPrice().gold - 6_000; // the iron rim is bought
    expect(room).toBe(total - Number((await treasury(guild))!.gold));
    expect(GUILD_HALL_UPGRADES.length).toBeGreaterThan(0);
  });

  it('leaving or a kick refunds nothing; the treasury stays with the guild', async () => {
    const t = (await treasury(guild))!;
    const gold = await goldOf(heroes[member.id]!);
    expect(status(await call(member, 'POST', '/api/guild/leave'))).toBe(200);
    expect(await goldOf(heroes[member.id]!)).toBe(gold);
    expect(Number((await treasury(guild))!.gold)).toBe(Number(t.gold));
    const officerGold = await goldOf(heroes[officer.id]!);
    expect(status(await call(leader, 'POST', `/api/guild/members/${officer.handle}/kick`))).toBe(
      200,
    );
    expect(await goldOf(heroes[officer.id]!)).toBe(officerGold);
    expect(Number((await treasury(guild))!.gold)).toBe(Number(t.gold));
    // Their gifts stay recorded with the guild (the cap rows), never moved or returned.
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });

  it('a disband forfeits the treasury (audited), and the books still balance', async () => {
    const t = (await treasury(guild))!;
    expect(Number(t.gold)).toBeGreaterThan(0);
    const res = await call(leader, 'POST', '/api/guild/disband', { name: guild.name });
    expect(res.statusCode, res.body).toBe(200);
    expect(Number((await treasury(guild))!.gold)).toBe(0);
    const [row] = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'guild.treasury_forfeit'));
    expect(row!.data).toMatchObject({ guildId: guild.id, gold: Number(t.gold) });
    const checks = await reconcileWithAudit(db());
    const mine = checks.filter((c) => c.check.startsWith('guild '));
    expect(mine.length).toBeGreaterThanOrEqual(10);
    expect(mine.filter((c) => !c.ok)).toEqual([]);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('test accounts fund only a guild of test accounts', async () => {
    const real = await insertAccount(db());
    const tester = await insertAccount(db());
    await setTestAccount(db(), tester.handle, true);
    await insertGuild(db(), real.id, { members: [{ accountId: tester.id, role: 'officer' }] });
    const hero = await rich(tester);
    expect(status(await give(tester, hero.id, [{ resource: 'gold', amount: 100 }]))).toBe(
      '403 test_account',
    );
    const t1 = await insertAccount(db());
    const t2 = await insertAccount(db());
    await setTestAccount(db(), t1.handle, true);
    await setTestAccount(db(), t2.handle, true);
    await insertGuild(db(), t1.id, { members: [{ accountId: t2.id }] });
    expect(status(await give(t2, (await rich(t2)).id, [{ resource: 'gold', amount: 100 }]))).toBe(
      200,
    );
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });

  it('a retry with the same key replays and gives once', async () => {
    const a = await insertAccount(db());
    const b = await insertAccount(db());
    const g = await insertGuild(db(), a.id, { members: [{ accountId: b.id }] });
    const hero = await rich(b);
    const key = randomUUID();
    const body = {
      characterId: hero.id,
      offer: [{ resource: 'gold', amount: 500 }],
      acknowledgeNoRefund: true,
    };
    const r1 = await post(b, '/api/guild/hall/contribute', body, key);
    const r2 = await post(b, '/api/guild/hall/contribute', body, key);
    expect(r1.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    expect(Number((await treasury(g))!.gold)).toBe(500);
  });

  it('invariance: giving, buying and hanging change no 5.1 score', async () => {
    const a = await insertAccount(db());
    const g = await insertGuild(db(), a.id);
    const hero = await rich(a);
    const scores = async () => (await call(a, 'GET', `/api/characters/${hero.id}/scores`)).json();
    const before = await scores();
    await give(a, hero.id, [
      { resource: 'gold', amount: 6_000 },
      { resource: 'ironOre', amount: 29 },
    ]);
    nowMs += DAY;
    await give(a, hero.id, [{ resource: 'ironOre', amount: 29 }]);
    nowMs += DAY;
    await give(a, hero.id, [{ resource: 'ironOre', amount: 2 }]);
    expect(
      status(await post(a, '/api/guild/hall/buy', { upgradeId: 'crest-frame.iron-rim' })),
    ).toBe(200);
    await post(a, '/api/guild/hall/display', { crestFrame: 'crest-frame.iron-rim' });
    expect(await scores()).toEqual(before);
    void g;
  });
});
