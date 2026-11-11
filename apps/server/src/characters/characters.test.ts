import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { accounts, auditLog, characters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import type { CharacterView } from './routes.js';
import { NAME_SAFE_LETTERS } from '../test/names.js';

let database: DatabaseHandle;
let app: FastifyInstance;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database, auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface Player {
  token: string;
  accountId: string;
}

let seq = 0;
async function newPlayer(): Promise<Player> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `hero${seq}@graumark.test`,
      displayName: `Hero ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${res.statusCode}`);
  return { token, accountId: res.json<{ account: { id: string } }>().account.id };
}

/** Unique, rule-abiding names (letters only). */
let nameSeq = 0;
function freshName(): string {
  nameSeq += 1;
  let n = nameSeq;
  let suffix = '';
  do {
    suffix = NAME_SAFE_LETTERS[n % NAME_SAFE_LETTERS.length]! + suffix;
    n = Math.floor(n / NAME_SAFE_LETTERS.length);
  } while (n > 0);
  return `Edric${suffix}`;
}

const create = (p: Player | null, payload: object) =>
  app.inject({
    method: 'POST',
    url: '/api/characters',
    payload,
    cookies: p ? { [SESSION_COOKIE]: p.token } : {},
  });
const list = (p: Player | null) =>
  app.inject({
    method: 'GET',
    url: '/api/characters',
    cookies: p ? { [SESSION_COOKIE]: p.token } : {},
  });
const select = (p: Player, id: string) =>
  app.inject({
    method: 'POST',
    url: `/api/characters/${id}/select`,
    cookies: { [SESSION_COOKIE]: p.token },
  });

const body = (overrides: object = {}) => ({
  name: freshName(),
  classId: 'warrior',
  appearance: { banner: 'ember' },
  ...overrides,
});

interface ListBody {
  characters: CharacterView[];
  slots: { used: number; total: number };
  activeCharacterId: string | null;
}

describe('characters API', () => {
  it('requires a session', async () => {
    expect((await list(null)).statusCode).toBe(401);
    expect((await create(null, body())).statusCode).toBe(401);
  });

  it('starts empty with two slots', async () => {
    const p = await newPlayer();
    const res = await list(p);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      characters: [],
      slots: { used: 0, total: 2 },
      activeCharacterId: null,
    });
  });

  it('creates a level 1 character, selects it and audits it', async () => {
    const p = await newPlayer();
    const res = await create(p, body({ name: '  Mael-Dun ', classId: 'warlock' }));
    expect(res.statusCode).toBe(201);
    const { character } = res.json<{ character: CharacterView }>();
    expect(character).toMatchObject({
      name: 'Mael-Dun',
      classId: 'warlock',
      appearance: { banner: 'ember' },
      level: 1,
      experience: 0,
      gold: 0,
    });

    const listed = (await list(p)).json<ListBody>();
    expect(listed.characters).toEqual([character]);
    expect(listed.slots).toEqual({ used: 1, total: 2 });
    expect(listed.activeCharacterId).toBe(character.id);

    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.characterId, character.id));
    expect(audits.map((a) => [a.event, a.accountId, a.data])).toEqual([
      ['character.create', p.accountId, { classId: 'warlock' }],
    ]);
  });

  it.each(['warrior', 'mage', 'hunter', 'warlock'])('allows the %s class', async (classId) => {
    const p = await newPlayer();
    const res = await create(p, body({ classId }));
    expect(res.statusCode).toBe(201);
    expect(res.json<{ character: CharacterView }>().character.classId).toBe(classId);
  });

  it('rejects bad names, unknown classes and unknown banners per field', async () => {
    const p = await newPlayer();
    const res = await create(p, {
      name: 'Ed 1',
      classId: 'paladin',
      appearance: { banner: 'gold' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json<{ error: { code: string; details: { fields: object } } }>();
    expect(error.code).toBe('validation_failed');
    expect(Object.keys(error.details.fields).sort()).toEqual([
      'appearance.banner',
      'classId',
      'name',
    ]);
    expect((await list(p)).json<ListBody>().slots.used).toBe(0);
  });

  it('rejects client-supplied progress fields', async () => {
    const p = await newPlayer();
    const res = await create(p, { ...body(), gold: 1_000_000 });
    expect(res.statusCode).toBe(400);
    const level = await create(p, { ...body(), level: 60 });
    expect(level.statusCode).toBe(400);
  });

  it('keeps names unique across accounts, case-insensitively', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const name = freshName();
    expect((await create(a, body({ name }))).statusCode).toBe(201);
    const res = await create(b, body({ name: name.toUpperCase() }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'character_name_taken', details: { fields: { name: expect.any(String) } } },
    });
  });

  it('enforces the slot limit on the server', async () => {
    const p = await newPlayer();
    expect((await create(p, body())).statusCode).toBe(201);
    expect((await create(p, body())).statusCode).toBe(201);
    const third = await create(p, body());
    expect(third.statusCode).toBe(422);
    expect(third.json()).toMatchObject({
      error: { code: 'no_free_slot', details: { slots: { used: 2, total: 2 } } },
    });
    expect((await list(p)).json<ListBody>().characters).toHaveLength(2);
  });

  it('enforces the slot limit for concurrent requests', async () => {
    const p = await newPlayer();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(p, body())));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 201, 422, 422, 422]);
    const rows = await database.db
      .select()
      .from(characters)
      .where(eq(characters.accountId, p.accountId));
    expect(rows).toHaveLength(2);
  });

  it('respects a per-account slot count', async () => {
    const p = await newPlayer();
    await database.db
      .update(accounts)
      .set({ characterSlots: 3 })
      .where(eq(accounts.id, p.accountId));
    for (let i = 0; i < 3; i++) expect((await create(p, body())).statusCode).toBe(201);
    expect((await create(p, body())).statusCode).toBe(422);
    expect((await list(p)).json<ListBody>().slots).toEqual({ used: 3, total: 3 });
  });

  it('selects one of the account’s characters', async () => {
    const p = await newPlayer();
    const first = (await create(p, body())).json<{ character: CharacterView }>().character;
    const second = (await create(p, body())).json<{ character: CharacterView }>().character;
    expect((await list(p)).json<ListBody>().activeCharacterId).toBe(second.id);

    const res = await select(p, first.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ character: first });
    expect((await list(p)).json<ListBody>().activeCharacterId).toBe(first.id);
  });

  it('refuses to select another account’s character, or one that does not exist', async () => {
    const owner = await newPlayer();
    const other = await newPlayer();
    const c = (await create(owner, body())).json<{ character: CharacterView }>().character;

    const res = await select(other, c.id);
    // 404, not 403: the answer must not reveal that the id exists (ticket 1.9).
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await list(other)).json<ListBody>().activeCharacterId).toBeNull();

    const missing = await select(other, '01900000-0000-7000-8000-000000000000');
    expect(missing.statusCode).toBe(404);
    expect((await select(other, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('lists only the account’s own characters', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    await create(a, body());
    expect((await list(b)).json<ListBody>().characters).toEqual([]);
  });
});
