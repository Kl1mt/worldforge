/**
 * A server clock that runs `scale` times faster than real time from `origin` on. Test/e2e only
 * (`src/e2e/serve.ts`): it lets farming produce loot within seconds. It is a server-side setting;
 * nothing a client sends can move it.
 */
export function scaledClock(scale: number, origin = Date.now(), real = () => Date.now()) {
  if (!Number.isFinite(scale) || scale < 1) throw new RangeError(`Invalid clock scale: ${scale}`);
  return (): Date => new Date(origin + (real() - origin) * scale);
}
