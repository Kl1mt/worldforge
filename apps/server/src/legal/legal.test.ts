import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { LEGAL_PAGES, TEMPLATE_MARKER, findTemplateDir } from './routes.js';

let database: DatabaseHandle;
let ownerDir: string;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  ownerDir = mkdtempSync(join(tmpdir(), 'wf-legal-'));
  writeFileSync(join(ownerDir, 'impressum.md'), '# Impressum\n\nErika Musterfrau\n');
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await database.close();
  rmSync(ownerDir, { recursive: true, force: true });
});

async function makeApp(dir?: string) {
  const a = buildApp({ database, legal: { dir } });
  apps.push(a);
  await a.ready();
  return a;
}

describe('legal pages', () => {
  it('ships a marked template for every page', () => {
    expect(findTemplateDir()).toMatch(/content[/\\]legal$/);
  });

  it('serves the templates publicly, flagged as templates', async () => {
    const a = await makeApp();
    for (const page of LEGAL_PAGES) {
      const res = await a.inject({ method: 'GET', url: `/api/legal/${page}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.page).toBe(page);
      expect(body.template).toBe(true);
      expect(body.markdown).toContain(TEMPLATE_MARKER);
      expect(body.markdown).toMatch(/keine Rechtsberatung/);
    }
    const impressum = (await a.inject({ method: 'GET', url: '/api/legal/impressum' })).json();
    expect(impressum.markdown).toMatch(/§ 5 DDG/);
    const privacy = (await a.inject({ method: 'GET', url: '/api/legal/datenschutz' })).json();
    for (const topic of [
      /E-Mail-Adresse/,
      /Anzeigename/,
      /IP-Adresse/,
      /Cloudflare/,
      /Deutschland/,
      /Art\. 15/,
      /Sitzungs-Cookie/,
    ]) {
      expect(privacy.markdown).toMatch(topic);
    }
  });

  it("prefers the owner's file and falls back per page", async () => {
    const a = await makeApp(ownerDir);
    const own = (await a.inject({ method: 'GET', url: '/api/legal/impressum' })).json();
    expect(own).toEqual({
      page: 'impressum',
      markdown: '# Impressum\n\nErika Musterfrau\n',
      template: false,
    });
    const fallback = (await a.inject({ method: 'GET', url: '/api/legal/datenschutz' })).json();
    expect(fallback.template).toBe(true);
    // Edits show without a restart.
    writeFileSync(join(ownerDir, 'datenschutz.md'), '# Datenschutz\n');
    const edited = (await a.inject({ method: 'GET', url: '/api/legal/datenschutz' })).json();
    expect(edited.markdown).toBe('# Datenschutz\n');
  });

  it('answers 404 for anything else, including path tricks', async () => {
    const a = await makeApp(ownerDir);
    for (const url of ['/api/legal/agb', '/api/legal/..%2Fpackage', '/api/legal/impressum.md']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });
});
