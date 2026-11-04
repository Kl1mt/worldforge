import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the OWASP baseline (19 MiB, 2 passes, 1 lane). The parameters are stored in
 * the PHC string, so raising them later only affects new hashes; old ones keep verifying.
 */
const ARGON2_OPTIONS = {
  // Algorithm.Argon2id; a literal because the package exports it as an ambient const enum.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** `false` for a wrong password *or* a malformed stored hash; never throws on bad input. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same work as a real verification. Login calls this for unknown emails so the
 * response time does not reveal whether an account exists.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('worldforge-timing-equaliser');
  await verifyPassword(await dummyHash, password);
  return false;
}
