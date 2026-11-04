import type { ApiFailure } from '../lib/api';

/**
 * Idempotency keys on the client (ticket 2.6). Each intended action (sell these items, buy this
 * offer, craft this recipe) gets one key, kept until the server has given a definite answer. A
 * retry after a network failure or a 5xx reuses the key, so if the first attempt did commit the
 * server replays it instead of selling or crafting twice. A success or a rule refusal (4xx) ends
 * the action; doing it again is a new action with a new key.
 */
export class ActionKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly make: () => string = () => crypto.randomUUID()) {}

  /** The key for this action, created on first use. */
  keyFor(action: string): string {
    let key = this.keys.get(action);
    if (!key) {
      key = this.make();
      this.keys.set(action, key);
    }
    return key;
  }

  /** Records the outcome: forget the key unless the outcome was uncertain. */
  settle(action: string, error: ApiFailure | null): void {
    if (error === null || !isUncertain(error)) this.keys.delete(action);
  }
}

/** The request may or may not have been applied: retry with the same key. */
export function isUncertain(error: Pick<ApiFailure, 'status'>): boolean {
  return error.status === 0 || error.status >= 500;
}

/** Stable action names: the same items in any order are the same action. */
export function itemsAction(kind: string, itemIds: readonly string[]): string {
  return `${kind}:${[...itemIds].sort().join(',')}`;
}

/** Time until the merchant restocks, as "5 h 12 min" / "12 min" / "under a minute". */
export function restockIn(restocksAt: string, now: number): string {
  const ms = Date.parse(restocksAt) - now;
  if (ms < 60_000) return 'under a minute';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
