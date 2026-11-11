# Balance measurements (tickets B.2, 4.8, B.3, 5.4, 5.6, B.4, T.7, 6.1, 6.2, 6.5, B.5, 6.10)

Dev scripts behind the before/after tables in `docs/COMBAT.md`, `docs/DUNGEONS.md`, `docs/EFFECTS.md`, `docs/PVP.md` and `docs/LEADERBOARDS.md`. Not run in CI (the guards are `packages/game-core/src/balance/*.test.ts`). Run from the repo root:

```
pnpm --filter @worldforge/server exec tsx ../../tools/balance/builds.ts boss   # or: farm
pnpm --filter @worldforge/server exec tsx ../../tools/balance/drop-rates.ts
pnpm --filter @worldforge/server exec tsx ../../tools/balance/crypt-farmed.ts   # HOURS=10,30 UPS=0,5 TIER=3
pnpm --filter @worldforge/server exec tsx ../../tools/balance/ashen-pass.ts farm   # or: builds, warden, tier3 (ticket 4.8)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/top-end.ts pass   # or: tier3, overlevel (ticket B.3)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/cinderwastes.ts farm   # or: xp (ticket 6.1; KIT=legendary for the plain kit)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/cinder-depths.ts farm   # or: boss, xp (ticket 6.2; SEEDS, RUNS, LEVELS=36,38,40, KITS="legendary +10,best +5")
pnpm --filter @worldforge/server exec tsx ../../tools/balance/guild-boss.ts   # weekly guild-boss totals (ticket B.3)
pnpm --filter @worldforge/server exec tsx --conditions=source ../../tools/balance/sim-state.ts ../../.telemetry-sample   # end state of a telemetry:simulate run (ticket B.3)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/pvp.ts report   # or: tune (ticket 5.4: PvP bands, class damage factors)
pnpm --filter @worldforge/server exec tsx ../../tools/balance/arena.ts   # ticket 5.6: matchmaking on the synthetic population
# Ticket B.4: a realistic season (three runs side by side, ~30 min), then the competitive systems on it
pnpm --filter @worldforge/server telemetry:simulate -- --dir .season-a --days 56 --snapshots   # also .season-b, .season-c
pnpm --filter @worldforge/server exec tsx ../../tools/balance/competitive.ts boards ../../.season-a ../../.season-b ../../.season-c
ARENA=offers pnpm --filter @worldforge/server exec tsx ../../tools/balance/competitive.ts arena ../../.season-a ../../.season-b ../../.season-c   # or rating, fitscale, tune; MM=1 = 5.6's matchmaking; SIZES=20,100,500
pnpm --filter @worldforge/server exec tsx ../../tools/balance/export-arena-fixture.ts ../../.season-a ../../.season-b ../../.season-c   # rewrites game-core balance/realistic-arena.json
# Ticket T.7: trading and the shelf (four 7-day runs side by side, ~15 min), then the balance check
pnpm --filter @worldforge/server telemetry:simulate -- --dir .telemetry-sample/t7-base --days 7   # also: …/t7-alts --alts, …/t7-on --trading on, …/t7-all --trading all (under the git-ignored .telemetry-sample/)
pnpm --filter @worldforge/server exec tsx --conditions=source ../../tools/balance/trading.ts base=../../.telemetry-sample/t7-base alts=../../.telemetry-sample/t7-alts on=../../.telemetry-sample/t7-on all=../../.telemetry-sample/t7-all
# Ticket 6.5: Item Awakening (docs/AWAKENING.md), game-core only; STRENGTH=1.25 SHARE=1 for the untuned options
pnpm --filter @worldforge/server exec tsx ../../tools/balance/awakening.ts builds   # or: items, older, power, pvp, time, realistic, all
# Ticket B.5: the endgame pass (docs/BALANCE.md "B.5"); bosses takes TYRANT_SCALE=res,arm HEROIC_SCALE=res,arm TYRANT_SHELL=… TYRANT_BURN=… to try boss data
pnpm --filter @worldforge/server exec tsx ../../tools/balance/endgame.ts bosses   # or: pace, loot (HOURS=1500 RUNS=200), forgeward, event, older
MAX_LEVEL=40 AWAKENED=1 pnpm --filter @worldforge/server exec tsx ../../tools/balance/arena.ts 120 32 20   # 30+ to level 40; POWER=2 ranks by Character Power as before B.5
# Ticket 6.10: the Phase 6 exit criterion (docs/BALANCE.md "Phase 6 exit criterion"), ~1 min
pnpm --filter @worldforge/server exec tsx ../../tools/balance/phase6-exit.ts   # or: verge, older, materials, variants, awakening, modifiers (KITS, RUNS), bosses
```

To compare with another revision, run them in a worktree of it (`git worktree add`).
