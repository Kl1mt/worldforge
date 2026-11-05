/**
 * "New" markers (ticket 2.7): which items and quest notices this browser has already shown,
 * per character. Kept in localStorage because it is a per-device convenience, not game state.
 * The first time a list is seen on a device, everything in it counts as seen (no flood of
 * markers for an existing hero); only what arrives later is new.
 */
export interface SeenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Most ids kept per list; old ids fall off (items get discarded, contracts roll over). */
const MAX_IDS = 400;

export function browserStore(): SeenStore {
  return {
    get: (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage full or blocked: markers just are not remembered */
      }
    },
  };
}

export function seenKey(characterId: string, list: 'items' | 'quests'): string {
  return `wf.seen.${list}.${characterId}`;
}

/** The stored ids, or null if this device never stored the list. */
export function readSeen(store: SeenStore, key: string): Set<string> | null {
  const raw = store.get(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeSeen(store: SeenStore, key: string, ids: Iterable<string>): void {
  store.set(key, JSON.stringify([...ids].slice(-MAX_IDS)));
}

/** Ids among `current` that are new: not in `seen`. With no stored list nothing is new. */
export function newIds(current: readonly string[], seen: Set<string> | null): Set<string> {
  if (seen === null) return new Set();
  return new Set(current.filter((id) => !seen.has(id)));
}

/**
 * Keys of what the Tavern shows that can be "new": the story notice when it can be taken,
 * today's untaken contract slips, and quests ready to turn in.
 */
export function questKeys(board: {
  day: string;
  story: { next: { questId: string; blockers: readonly unknown[] } | null };
  contracts: { offers: readonly { slot: number; templateId: string; accepted: boolean }[] };
  quests: readonly { id: string; status: string }[];
}): string[] {
  const keys: string[] = [];
  const next = board.story.next;
  if (next && next.blockers.length === 0) keys.push(questKey.story(next.questId));
  for (const o of board.contracts.offers) {
    if (!o.accepted) keys.push(questKey.offer(board.day, o.slot, o.templateId));
  }
  for (const q of board.quests) if (q.status === 'ready') keys.push(questKey.ready(q.id));
  return keys;
}

export const questKey = {
  story: (questId: string) => `story:${questId}`,
  offer: (day: string, slot: number, templateId: string) => `offer:${day}:${slot}:${templateId}`,
  ready: (questRowId: string) => `ready:${questRowId}`,
};
