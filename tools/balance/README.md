# Balance measurements (tickets B.2, 4.8)

Dev scripts behind the before/after tables in `docs/COMBAT.md`, `docs/DUNGEONS.md` and `docs/EFFECTS.md`. Not run in CI (the guards are `packages/game-core/src/balance/*.test.ts`). Run from the repo root:

```
pnpm --filter @worldforge/server exec tsx ../../tools/balance/builds.ts boss   # or: farm
pnpm --filter @worldforge/server exec tsx ../../tools/balance/drop-rates.ts
pnpm --filter @worldforge/server exec tsx ../../tools/balance/crypt-farmed.ts   # HOURS=10,30 UPS=0,5 TIER=3
pnpm --filter @worldforge/server exec tsx ../../tools/balance/ashen-pass.ts farm   # or: builds, warden, tier3 (ticket 4.8)
```

To compare with another revision, run them in a worktree of it (`git worktree add`).
