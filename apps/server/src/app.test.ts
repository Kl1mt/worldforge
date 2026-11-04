import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CLASS_IDS, EQUIPMENT_SLOT_IDS, RARITY_IDS, type GameContent } from '@worldforge/game-core';
import { buildApp, type HealthResponse } from './app.js';
import type { DatabaseHandle } from './db/types.js';
import { createTestDatabase } from './test/db.js';

let app: FastifyInstance;
let database: DatabaseHandle;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('GET /api/health', () => {
  it('returns ok with the database up', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('up');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports 503 degraded when the database does not answer', async () => {
    const local = buildApp({
      database: {
        ...database,
        ping: () => Promise.reject(new Error('connection refused')),
      },
    });
    const res = await local.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json<HealthResponse>()).toMatchObject({ status: 'degraded', db: 'down' });
    await local.close();
  });
});

describe('GET /api/content', () => {
  it('returns the game-core definitions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/content' });
    expect(res.statusCode).toBe(200);
    const body = res.json<GameContent>();
    expect(body.classes.map((c) => c.id)).toEqual([...CLASS_IDS]);
    expect(body.rarities.map((r) => r.id)).toEqual([...RARITY_IDS]);
    expect(body.equipmentSlots.map((s) => s.id)).toEqual([...EQUIPMENT_SLOT_IDS]);
    expect(body.stats.length).toBeGreaterThan(0);
    expect(body.version).toBeTypeOf('number');
  });
});

describe('error envelope', () => {
  it('returns 404 with the standard envelope for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /api/nope not found' },
    });
  });

  it('hides internal error details behind a 500 envelope', async () => {
    const local = buildApp({ database });
    local.get('/api/boom', async () => {
      throw new Error('secret internals');
    });
    const res = await local.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    await local.close();
  });

  it('maps schema validation failures to 400 validation_failed', async () => {
    const local = buildApp({ database });
    local.get(
      '/api/echo',
      {
        schema: {
          querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
        },
      },
      async (req) => req.query,
    );
    const res = await local.inject({ method: 'GET', url: '/api/echo' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    await local.close();
  });
});
