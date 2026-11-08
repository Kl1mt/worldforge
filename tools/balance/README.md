# Balance measurements (tickets B.2, 4.8, B.3, 5.4, 5.6, B.4)

Dev scripts behind the before/after tables in `docs/COMBAT.md`, `docs/DUNGEONS.md`, `docs/EFFECTS.md`, `docs/PVP.md` and `docs/LEADERBOARDS.md`. Not run in CI (the guards are `packages/game-core/src/balance/*.test.ts`). Run from the repo root:

```
pnpm --filter @worldforge/server exec tsx ../../tools/balance/builds.ts boss   # or: farm
pnpm --filter @worldforge/server exec tsx ../../tools/balance/drop-rates.ts
pnpm --filter @worldforge/server exec tsx ../../tools/balance/crypt-farmed.ts   # HOURS=10,30 UPS=0,5 TIER=3
pnpm --filter @worldforge/server exec tsx ../../tools/balance/ashen-pass.ts farm   # or: builds, warden, tier3 (ticket 4.8)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/top-end.ts pass   # or: tier3, overlevel (ticket B.3)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/guild-boss.ts   # weekly guild-boss totals (ticket B.3)
pnpm --filter @worldforge/server exec tsx --conditions=source ../../tools/balance/sim-state.ts ../../.telemetry-sample   # end state of a telemetry:simulate run (ticket B.3)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/pvp.ts report   # or: tune (ticket 5.4: PvP bands, class damage factors)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/arena.ts   # ticket 5.6: matchmaking on the synthetic population
# Ticket B.4: a realistic season (three runs side by side, ~30 min), then the competitive systems on it
pnpm --filter @worldforge/server telemetry:simulate -- --dir .season-a --days 56 --snapshots   # also .season-b, .season-c
pnpm --filter @worldforge/server exec tsx ../../tools/balance/competitive.ts boards ../../.season-a ../../.season-b ../../.season-c
ARENA=offers pnpm --filter @worldforge/server exec tsx ../../tools/balance/competitive.ts arena ../../.season-a ../../.season-b ../../.season-c   # or rating, fitscale, tune; MM=1 = 5.6's matchmaking; SIZES=20,100,500
pnpm --filter @worldforge/server exec tsx ../../tools/balance/export-arena-fixture.ts ../../.season-a ../../.season-b ../../.season-c   # rewrites game-core balance/realistic-arena.json
```

To compare with another revision, run them in a worktree of it (`git worktree add`).
