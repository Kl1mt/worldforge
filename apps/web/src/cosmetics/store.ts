import { useEffect, useSyncExternalStore } from 'react';
import type { ApiFailure } from '../lib/api';
import { cosmeticsApi, type Collection } from './api';

/**
 * Ticket 6.8: the account's collection, fetched once and shared (the book, the area and crypt
 * scenes read the hero's palette from it). The book's equips replace it with the server's answer.
 */
export type CollectionLoad =
  { kind: 'loading' } | { kind: 'ready'; value: Collection } | { kind: 'error'; error: ApiFailure };

let state: CollectionLoad = { kind: 'loading' };
let inFlight: Promise<void> | null = null;
let fetched = false;
const listeners = new Set<() => void>();

function set(next: CollectionLoad) {
  state = next;
  for (const l of listeners) l();
}

export function setCollection(value: Collection) {
  fetched = true;
  set({ kind: 'ready', value });
}

/** Fetches (again); concurrent callers share one request. */
export function loadCollection(): Promise<void> {
  if (inFlight) return inFlight;
  if (state.kind === 'error') set({ kind: 'loading' });
  fetched = true;
  inFlight = cosmeticsApi
    .collection()
    .then(
      (res) =>
        set(res.ok ? { kind: 'ready', value: res.value } : { kind: 'error', error: res.error }),
      () => undefined,
    )
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Tests and sign-out: forget the cached collection. */
export function resetCollection() {
  fetched = false;
  inFlight = null;
  state = { kind: 'loading' };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useCollection(): CollectionLoad {
  const load = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!fetched) void loadCollection();
  }, []);
  return load;
}

/** The appearance a hero of this account wears (null: own colours, or not known yet). */
export function useHeroPalette(characterId: string): string | null {
  const load = useCollection();
  if (load.kind !== 'ready') return null;
  return load.value.heroes.find((h) => h.id === characterId)?.palette ?? null;
}
