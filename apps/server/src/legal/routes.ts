import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';

/**
 * Legal pages (ticket D.2, docs/DEPLOY.md "Legal pages"): the Impressum and the privacy policy,
 * public, rendered by the client from Markdown. The text is the owner's: `LEGAL_DIR` (on the VPS
 * a mounted `deploy/legal/`) wins per file; otherwise the placeholder templates shipped in
 * `content/legal/` are served, flagged `template: true` so the client can say so. Files are read
 * on each request, so an edit on the server shows without a restart.
 */
export const LEGAL_PAGES = ['impressum', 'datenschutz'] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];

/** A template carries this marker; the owner deletes the line when the page is filled in. */
export const TEMPLATE_MARKER = '<!-- worldforge:template -->';
const MAX_BYTES = 64 * 1024;

export interface LegalOptions {
  /** The owner's directory (`LEGAL_DIR`); a missing file falls back to the template. */
  dir?: string | undefined;
  /** The shipped templates. Default: the nearest `content/legal/` above this module. */
  templateDir?: string;
}

/** `content/legal/` in the repo (dev, tests) or next to `dist/` in the production image. */
export function findTemplateDir(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from, i = 0; i < 8; i++) {
    const candidate = join(dir, 'content', 'legal');
    if (existsSync(join(candidate, 'impressum.md'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`content/legal/ not found above ${from}`);
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_BYTES) throw new Error(`${path} is larger than ${MAX_BYTES} bytes`);
    return buf.toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function registerLegal(app: FastifyInstance, options: LegalOptions): Promise<void> {
  const templateDir = resolve(options.templateDir ?? findTemplateDir());
  const ownerDir = options.dir ? resolve(options.dir) : undefined;

  app.get<{ Params: { page: string } }>('/legal/:page', async (request, reply) => {
    const page = request.params.page;
    if (!(LEGAL_PAGES as readonly string[]).includes(page)) {
      throw new ApiError(404, 'not_found', 'No such page.');
    }
    const file = `${page}.md`;
    const markdown =
      (ownerDir ? await readIfPresent(join(ownerDir, file)) : null) ??
      (await readIfPresent(join(templateDir, file)));
    if (markdown === null) throw new Error(`legal page ${file} is missing`);
    void reply.header('Cache-Control', 'no-cache');
    return { page, markdown, template: markdown.includes(TEMPLATE_MARKER) };
  });
}
