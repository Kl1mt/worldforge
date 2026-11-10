import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // No-op unless `WF_CLOCK_SHIFT_DAYS` is set (time-bomb guard, ticket F.6).
    setupFiles: ['../../tools/vitest/clock-shift.mjs'],
    // Each test file creates and migrates its own PGlite database in `beforeAll`. On a cold
    // container (WASM compile + migrations) that exceeded the 10 s default, so CI could flake.
    hookTimeout: 60_000,
    // Server tests drive the real app on PGlite (permission matrices, simulated hours of play).
    // They are fast on a quiet machine, but on a busy CI runner the 5 s default flaked (CI #190).
    testTimeout: 20_000,
  },
});
