import {
  AREAS,
  DUNGEONS,
  DUNGEON_TIERS,
  ITEM_BASES,
  ITEM_SLOT_KINDS,
  areaUnlockBlockers,
  dungeonUnlockBlockers,
  findSet,
  getMaterial,
  getWorldFlag,
  hasDungeonTier,
  isWorldFlagId,
  mythicForBase,
  setForBase,
  type DungeonTier,
  type ItemBaseDefinition,
  type ItemSlotKind,
  type MaterialId,
  type UnlockBlocker,
  type WorldProgress,
} from '@worldforge/game-core';
import { describeAdminFailure } from './api';
import type { AccountFile, AdminItem, CurrencyMode, ItemLocation } from './tools-api';
import type { ApiFailure } from '../lib/api';

/**
 * Pure helpers of the admin inspector (ticket D.4): access to the cheat tools, failure texts,
 * previews of currency changes, item grouping, unlock summaries. No DOM, no requests.
 */

/** Every tool needs a reason of at least this many characters (the server's `REASON_MIN`). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export function reasonValid(reason: string): boolean {
  const n = reason.trim().length;
  return n >= REASON_MIN && n <= REASON_MAX;
}

/** The typed confirmation, as the server compares it (trimmed, any letter case). */
export function confirmMatches(expected: string, typed: string): boolean {
  return typed.trim().toLowerCase() === expected.trim().toLowerCase() && typed.trim() !== '';
}

/**
 * Who may use the cheat tools on this account: a test account (`test`), the admin's own
 * non-test account (`own`: changes show on public boards), or nobody (`blocked`).
 */
export type CheatAccess = 'test' | 'own' | 'blocked';

export function cheatAccess(account: Pick<AccountFile, 'testAccount' | 'own'>): CheatAccess {
  if (account.testAccount) return 'test';
  return account.own ? 'own' : 'blocked';
}

/** "not locked", "locked for 40 s", "locked for 2 min", "locked for 1 h 5 min". */
export function formatLock(ms: number): string {
  if (!(ms > 0)) return 'not locked';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `locked for ${s} s`;
  const min = Math.ceil(s / 60);
  if (min < 60) return `locked for ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return `locked for ${h} h${rest ? ` ${rest} min` : ''}`;
}

/** A compact one-line rendering of an audit row's data, cut to `max` characters. */
export function auditLine(data: unknown, max = 140): string {
  const render = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return '–';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      return depth > 1 ? `[${v.length}]` : `[${v.map((x) => render(x, depth + 1)).join(', ')}]`;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([k, x]) => x !== undefined && k !== 'by',
      );
      if (depth > 1) return `{${entries.length}}`;
      return entries.map(([k, x]) => `${k}: ${render(x, depth + 1)}`).join(depth ? ', ' : ' · ');
    }
    return String(v);
  };
  const out = render(data, 0).replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out || '–';
}

/** What the server answered, in plain words for the admin. */
export function describeToolFailure(error: ApiFailure): string {
  const details = (error.details ?? {}) as Record<string, unknown>;
  switch (error.code) {
    case 'test_account_required':
      return 'This tool works only on test accounts and on your own account. Mark a test account on the server with deploy/admin.sh test-account <handle> on.';
    case 'confirmation_mismatch':
      return typeof details.expected === 'string'
        ? `The confirmation doesn’t match. Type “${details.expected}” exactly.`
        : 'The confirmation doesn’t match.';
    case 'invalid_item': {
      const problems = Array.isArray(details.problems)
        ? details.problems.filter((p): p is string => typeof p === 'string')
        : [];
      return problems.length > 0
        ? `${error.message} ${problems.join(' ')}`
        : 'This combination isn’t a valid item.';
    }
    case 'idempotency_conflict':
      return 'This action was already sent with other details. Close it and start again.';
    default:
      return describeAdminFailure(error);
  }
}

/** The problems of an `invalid_item` answer (empty for any other failure). */
export function itemProblems(error: ApiFailure): string[] {
  if (error.code !== 'invalid_item') return [];
  const problems = (error.details as { problems?: unknown } | undefined)?.problems;
  return Array.isArray(problems) ? problems.filter((p): p is string => typeof p === 'string') : [];
}

/** Gold after a change, as the server would compute it; null when a removal can't happen. */
export function goldAfter(mode: CurrencyMode, before: number, amount: number): number | null {
  if (!Number.isInteger(amount) || amount < 1) return null;
  if (mode === 'remove') return before >= amount ? before - amount : null;
  return before + amount;
}

/** Materials after a change; null when a removal asks for more than the hero has. */
export function materialsAfter(
  mode: CurrencyMode,
  before: Record<string, number>,
  change: Record<string, number>,
): Record<string, number> | null {
  const after: Record<string, number> = { ...before };
  for (const [id, n] of Object.entries(change)) {
    if (!Number.isInteger(n) || n < 1) return null;
    const have = before[id] ?? 0;
    if (mode === 'remove' && have < n) return null;
    after[id] = mode === 'remove' ? have - n : have + n;
  }
  return after;
}

/** Parses a whole number field ("1,000" and "1 000" allowed); null when it isn't one. */
export function parseWhole(text: string): number | null {
  const t = text.replace(/[\s,_]/g, '');
  if (!/^\d{1,12}$/.test(t)) return null;
  return Number(t);
}

export const LOCATION_ORDER: readonly ItemLocation[] = [
  'equipped',
  'pack',
  'warehouse',
  'escrow',
  'shelf',
];

export const LOCATION_LABEL: Record<ItemLocation, string> = {
  equipped: 'Equipped',
  pack: 'Pack',
  warehouse: 'Warehouse',
  escrow: 'In a trade offer',
  shelf: 'Account shelf',
};

/** Items by location, in `LOCATION_ORDER`; empty locations are left out. */
export function groupByLocation(
  items: readonly AdminItem[],
): { location: ItemLocation; items: AdminItem[] }[] {
  return LOCATION_ORDER.map((location) => ({
    location,
    items: items.filter((i) => i.location === location),
  })).filter((g) => g.items.length > 0);
}

/** Why an item can't be removed right now, or null. */
export function removeBlockedText(
  item: Pick<AdminItem, 'removeBlocked' | 'holdUntil'>,
): string | null {
  if (item.removeBlocked === 'escrow') {
    return 'In an open trade offer: void the offer first (removal is refused while it is escrowed).';
  }
  if (item.removeBlocked === 'held') {
    return item.holdUntil
      ? `Held after a trade until ${new Date(item.holdUntil).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`
      : 'Held after a trade.';
  }
  return null;
}

/** "Set: Gravecaller’s Vestments" / "Mythic" / "Unique boss drop" / null for an ordinary base. */
export function baseTag(base: Pick<ItemBaseDefinition, 'id' | 'unique'>): string | null {
  const set = setForBase(base.id);
  if (set) return `Set: ${findSet(set.id)?.name ?? set.name}`;
  if (mythicForBase(base.id)) return 'Mythic';
  if (base.unique) return 'Unique boss drop';
  return null;
}

/** Item bases by slot kind, in slot order, each with its tag (set, mythic, unique). */
export function basesBySlot(): {
  slot: ItemSlotKind;
  bases: { id: string; name: string; tag: string | null; minItemLevel: number }[];
}[] {
  return ITEM_SLOT_KINDS.map((slot) => ({
    slot,
    bases: ITEM_BASES.filter((b) => b.slot === slot).map((b) => ({
      id: b.id,
      name: b.name,
      tag: baseTag(b),
      minItemLevel: b.minItemLevel,
    })),
  })).filter((g) => g.bases.length > 0);
}

/** One unmet unlock condition in plain words. World flags are unknown here: named, not judged. */
export function blockerText(b: UnlockBlocker): string {
  switch (b.kind) {
    case 'level':
      return `needs level ${b.required}`;
    case 'gravewardenDefeated':
      return 'needs the Gravewarden defeated';
    case 'cryptTier':
      return `needs crypt tier ${['I', 'II', 'III'][b.tier - 1] ?? b.tier} cleared`;
    case 'ashenWardenDefeated':
      return 'needs the Ashen Warden defeated';
    case 'forgeTyrantDefeated':
      return 'needs the Forge Tyrant defeated';
    case 'worldFlag':
      return `needs the world flag “${isWorldFlagId(b.flag) ? getWorldFlag(b.flag).opens : b.flag}”`;
  }
}

export interface PlaceUnlock {
  id: string;
  name: string;
  /** Unmet conditions other than world flags; empty = open for this hero. */
  missing: string[];
  /** World flags it also needs (the client can't tell whether they are set). */
  flags: string[];
}

/** Which areas and dungeon tiers a hero at `level` with `progress` would have open. */
export function unlockSummary(level: number, progress: WorldProgress): PlaceUnlock[] {
  const who = { level: Math.max(1, Math.floor(level)) };
  const split = (id: string, name: string, blockers: UnlockBlocker[]): PlaceUnlock => ({
    id,
    name,
    missing: blockers.filter((b) => b.kind !== 'worldFlag').map(blockerText),
    flags: blockers.filter((b) => b.kind === 'worldFlag').map(blockerText),
  });
  const areas = AREAS.map((a) => split(a.id, a.name, areaUnlockBlockers(a.id, who, progress)));
  const dungeons = DUNGEONS.flatMap((d) =>
    DUNGEON_TIERS.filter((t) => hasDungeonTier(d.id, t)).map((t: DungeonTier) =>
      split(
        `${d.id}.${t}`,
        `${d.name}${t > 1 || hasDungeonTier(d.id, 2) ? `, tier ${['I', 'II', 'III'][t - 1]}` : ''}`,
        dungeonUnlockBlockers(d.id, who, progress, t),
      ),
    ),
  );
  return [...areas, ...dungeons];
}

/** A material's name, or its id for one that left the content. */
export function materialName(id: string): string {
  try {
    return getMaterial(id as MaterialId).name;
  } catch {
    return id;
  }
}

/** "1,234" */
export const nf = (n: number): string => n.toLocaleString('en-GB');
