/**
 * Ticket F.3: game versions are `0.<phase>.<patch>`. The minor number is the roadmap phase, the
 * patch number counts the player-visible releases within it (`docs/DEVELOPMENT.md`).
 */
export interface GameVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `"0.5.2"` → its parts, or null when it is not a plain `x.y.z` version. */
export function parseVersion(version: string): GameVersion | null {
  const m = VERSION_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Negative when `a` is older than `b`, 0 when equal, positive when newer. A version that does
 * not parse counts as older than every valid one (a stored value from nowhere is "never seen").
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * Ticket F.4: whether `candidate` (e.g. the server's version from `GET /api/health`) is strictly
 * newer than `current` (the version this build was made at). Anything that is not a plain
 * `x.y.z` string on either side is never newer, so a malformed or missing answer never prompts.
 */
export function isNewerVersion(candidate: unknown, current: string): boolean {
  if (typeof candidate !== 'string') return false;
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}
