import type { AreaId } from '../world/areas.js';

/** The area part of a running activity. */
export interface ActivityAreaState {
  /** Area of the cycle in progress (and of every cycle until a pending switch happens). */
  areaId: AreaId;
  /** Area to travel to once the cycle in progress completes; null = none. */
  pendingAreaId: AreaId | null;
  /** Time already spent in the cycle in progress (the settlement's `unusedMs`). */
  carryMs: number;
}

/**
 * Applies a request to farm `target` to a running activity that has just been settled (ticket 2.2).
 *
 * The cycle in progress always finishes in the area where it started: with `carryMs > 0` the switch
 * becomes pending and `settleFarming` (via `switchToAreaId`) applies it at the end of that cycle.
 * Without a cycle in progress (and no pending switch) it takes effect at once. So no cycle index is ever simulated in two
 * areas, an area switch cannot re-roll the encounter in progress, and — because the server settles
 * before calling this — the result of a switch does not depend on how often the client settles.
 *
 * Requesting the current area cancels a pending switch; requesting another area replaces it.
 */
export function requestAreaChange(state: ActivityAreaState, target: AreaId): ActivityAreaState {
  if (!Number.isInteger(state.carryMs) || state.carryMs < 0) {
    throw new RangeError(`Invalid carryMs: ${state.carryMs}`);
  }
  if (target === state.areaId) return { ...state, pendingAreaId: null };
  // A pending switch means a cycle is bound to `areaId` even before any time passed in it (a start
  // that replays the cycle a stop left unfinished), so only a free activity switches at once.
  if (state.carryMs === 0 && state.pendingAreaId === null)
    return { ...state, areaId: target, pendingAreaId: null };
  return { ...state, pendingAreaId: target };
}
