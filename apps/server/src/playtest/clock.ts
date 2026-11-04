/**
 * The local playtest server's farming clock (ticket P.1). With `scale` 1 it is the real clock
 * shifted by `offsetMs`; with `scale` > 1 ("fast time") it also runs `scale` times faster than real
 * time while the server is up, so offline progress and the 3 h cap can be seen in minutes.
 *
 * Unlike the e2e clock (`src/e2e/clock.ts`), the playtest database survives restarts, so the clock
 * must never run backwards across them: the offset it has built up is saved (`offsetMs()`) and
 * passed back in on the next start, and `startOffsetMs` clamps it to the newest farming timestamp
 * already stored. It is a server-side setting; nothing a client sends can move it.
 */
export interface PlaytestClock {
  now: () => Date;
  /** How far ahead of real time the clock currently is, to persist across restarts. */
  offsetMs: () => number;
}

export function playtestClock({
  scale,
  offsetMs,
  real = () => Date.now(),
}: {
  scale: number;
  offsetMs: number;
  real?: () => number;
}): PlaytestClock {
  if (!Number.isFinite(scale) || scale < 1) throw new RangeError(`Invalid time scale: ${scale}`);
  if (!Number.isFinite(offsetMs) || offsetMs < 0) {
    throw new RangeError(`Invalid clock offset: ${offsetMs}`);
  }
  const origin = real();
  const at = (r: number) => r + offsetMs + (r - origin) * (scale - 1);
  return {
    now: () => new Date(at(real())),
    offsetMs: () => {
      const r = real();
      return at(r) - r;
    },
  };
}

/**
 * The offset to start with: the saved one, raised if the database already holds farming times
 * ahead of `realNowMs` (e.g. the saved offset was lost after a crash), so time never goes back.
 */
export function startOffsetMs(
  savedOffsetMs: number | undefined,
  latestStoredMs: number | null,
  realNowMs: number,
): number {
  const saved =
    savedOffsetMs !== undefined && Number.isFinite(savedOffsetMs) && savedOffsetMs > 0
      ? savedOffsetMs
      : 0;
  const floor = latestStoredMs === null ? 0 : latestStoredMs - realNowMs;
  return Math.max(0, saved, floor);
}
