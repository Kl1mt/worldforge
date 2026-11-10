/**
 * Time-bomb guard (ticket F.6), a Vitest setup file for every package.
 *
 * With `WF_CLOCK_SHIFT_DAYS=<n>` set, each test file sees the wall clock `n` days ahead:
 * `Date.now()`, `new Date()` and, on the server, PGlite's `now()` (it reads the JS clock), so a
 * column that defaults to `now()` lands in the future. A test that hard-codes an absolute date
 * and lets the clock fill a compared value (an expiry, a season, a token, a "how long ago")
 * then fails today instead of on the day that date passes. Without the variable it does nothing.
 *
 * CI runs the server and web suites shifted (`.github/workflows/ci.yml`, "Time-bomb guard").
 * Real PostgreSQL keeps its own clock, so `test:pg` is not covered; its tests set every
 * compared column from the injected clock.
 */
const days = Number(process.env.WF_CLOCK_SHIFT_DAYS ?? '0');
const RealDate = globalThis.Date;

if (Number.isFinite(days) && days !== 0 && !RealDate.shifted) {
  const offset = days * 86_400_000;
  class ShiftedDate extends RealDate {
    static shifted = true;
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
