import { randomBytes } from 'node:crypto';

// No runtime import from game-core here: the schema uses `newHandle` as a column default, and
// drizzle-kit loads the schema without the workspace `source` condition. `handles.test.ts` checks
// that this alphabet matches game-core's `HANDLE_ALPHABET`/`HANDLE_RE`.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 12;

/**
 * A fresh public handle (ticket 4.1, docs/SOCIAL.md "Handles"): 60 random bits from the OS RNG,
 * independent of the account id, so nothing about the account can be derived from it.
 */
export function newHandle(): string {
  const bytes = randomBytes(LENGTH);
  let s = '';
  for (let i = 0; i < LENGTH; i++) s += ALPHABET[bytes[i]! & 31];
  return s;
}

export const HANDLE_ALPHABET_FOR_TEST = ALPHABET;
