import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // No-op unless `WF_CLOCK_SHIFT_DAYS` is set (time-bomb guard, ticket F.6).
    setupFiles: ['../../tools/vitest/clock-shift.mjs'],
  },
});
