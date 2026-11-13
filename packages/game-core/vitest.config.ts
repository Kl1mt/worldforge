import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // No-op unless `WF_CLOCK_SHIFT_DAYS` is set (time-bomb guard, ticket F.6).
    // Ticket 9.1: no-op unless `WF_SKILLS_PROTOTYPE` is set (the default-loadout replay).
    setupFiles: ['../../tools/vitest/clock-shift.mjs', '../../tools/vitest/skills-prototype.mjs'],
  },
});
