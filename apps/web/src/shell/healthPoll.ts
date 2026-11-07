import { useSyncExternalStore } from 'react';
import { fetchHealth, type HealthState } from '../health';

/**
 * Ticket F.4: one shared, light poll of `GET /api/health` for the status line ("Server online")
 * and the new-version check. Every 5 minutes while the tab is visible, plus once when the tab
 * comes back after at least a minute away (a deploy usually lands while the player looks
 * elsewhere). That is one small request per 5 minutes per tab, far below any limit.
 */
export const HEALTH_POLL_MS = 5 * 60_000;
/** A tab coming back re-checks only if the last check is at least this old. */
export const HEALTH_STALE_MS = 60_000;

export interface HealthSnapshot {
  health: HealthState;
  /** The newest version string the server answered with (null until one arrives). */
  serverVersion: string | null;
}

export interface HealthPollDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Whether the tab is hidden (no checks then; it re-checks when it comes back). */
  hidden: () => boolean;
  /** Calls `fn` whenever the tab becomes visible again; returns an unsubscribe. */
  onVisible: (fn: () => void) => () => void;
  pollMs?: number;
  staleMs?: number;
}

export interface HealthPoll {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HealthSnapshot;
  /** Checks now unless a check is running or the last one is younger than `staleMs`. */
  refresh: () => void;
}

const INITIAL: HealthSnapshot = { health: { kind: 'loading' }, serverVersion: null };

/** The poll runs while anything subscribes and stops (aborting a running check) when nothing does. */
export function createHealthPoll(deps: HealthPollDeps): HealthPoll {
  const pollMs = deps.pollMs ?? HEALTH_POLL_MS;
  const staleMs = deps.staleMs ?? HEALTH_STALE_MS;
  const listeners = new Set<() => void>();
  let snapshot = INITIAL;
  let timer: unknown = null;
  let inflight: AbortController | null = null;
  let lastCheck = -Infinity;
  let stopVisible: (() => void) | null = null;

  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const schedule = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = deps.setTimer(tick, pollMs);
  };
  const check = () => {
    if (inflight) return;
    const controller = new AbortController();
    inflight = controller;
    lastCheck = deps.now();
    fetchHealth(deps.fetchImpl, controller.signal).then(
      (health) => {
        if (inflight !== controller) return;
        inflight = null;
        const serverVersion =
          health.kind === 'ok' && health.version ? health.version : snapshot.serverVersion;
        snapshot = { health, serverVersion };
        emit();
        if (listeners.size > 0) schedule();
      },
      () => {
        /* aborted: the poll stopped */
        if (inflight === controller) inflight = null;
      },
    );
  };
  function tick() {
    timer = null;
    if (deps.hidden()) schedule();
    else check();
  }
  const refresh = () => {
    if (listeners.size === 0 || inflight || deps.hidden()) return;
    if (deps.now() - lastCheck < staleMs) return;
    check();
  };
  const start = () => {
    stopVisible = deps.onVisible(refresh);
    // A remount soon after a check (StrictMode, a screen change) reuses the last answer.
    if (deps.now() - lastCheck >= staleMs || snapshot.health.kind === 'loading') check();
    else schedule();
  };
  const stop = () => {
    stopVisible?.();
    stopVisible = null;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    inflight?.abort();
    inflight = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    refresh,
  };
}

function browserDeps(): HealthPollDeps {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    hidden: () => document.visibilityState === 'hidden',
    onVisible: (fn) => {
      const onChange = () => {
        if (document.visibilityState === 'visible') fn();
      };
      document.addEventListener('visibilitychange', onChange);
      window.addEventListener('focus', fn);
      return () => {
        document.removeEventListener('visibilitychange', onChange);
        window.removeEventListener('focus', fn);
      };
    },
  };
}

let shared: HealthPoll | null = null;
function sharedPoll(): HealthPoll {
  shared ??= createHealthPoll(browserDeps());
  return shared;
}

const subscribeShared = (l: () => void) => sharedPoll().subscribe(l);
const snapshotShared = () => sharedPoll().getSnapshot();
const serverSnapshot = () => INITIAL;

/** The shared health poll's latest answer (the status line and the new-version check). */
export function useHealthPoll(): HealthSnapshot {
  return useSyncExternalStore(subscribeShared, snapshotShared, serverSnapshot);
}
