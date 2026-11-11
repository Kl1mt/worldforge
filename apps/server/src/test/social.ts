import type { FastifyInstance } from 'fastify';
import type { AccountRole } from '@worldforge/game-core';
import { SESSION_COOKIE, createSession } from '../auth/index.js';
import { accounts } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { NAME_SAFE_LETTERS } from './names.js';

export interface TestAccount {
  id: string;
  handle: string;
  displayName: string;
  token: string;
  role: AccountRole;
}

let seq = 0;
const letters = (n: number) => {
  let s = '';
  do {
    s = NAME_SAFE_LETTERS[n % NAME_SAFE_LETTERS.length]! + s;
    n = Math.floor(n / NAME_SAFE_LETTERS.length);
  } while (n > 0);
  return s;
};

/**
 * An account with a role and a live session, inserted directly (no argon2, so tests that need
 * many accounts stay fast). Roles never come from the API; this is the test stand-in for the CLI.
 */
export async function insertAccount(
  db: Database,
  {
    role = 'player',
    name,
    now = new Date(),
  }: { role?: AccountRole; name?: string; now?: Date } = {},
): Promise<TestAccount> {
  seq += 1;
  const displayName = name ?? `Tester ${letters(seq)}`;
  const [row] = await db
    .insert(accounts)
    .values({
      id: uuidv7(),
      email: `tester-${seq}-${letters(seq)}@graumark.test`,
      displayName,
      passwordHash: 'not-a-real-hash',
      role,
    })
    .returning();
  const { token } = await createSession(
    db,
    row!.id,
    new Date(now.getTime() - 1000),
    30 * 86_400_000,
  );
  return { id: row!.id, handle: row!.handle, displayName, token, role };
}

export function caller(app: FastifyInstance) {
  return (who: TestAccount | null, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      ...(who ? { cookies: { [SESSION_COOKIE]: who.token } } : {}),
    });
}
