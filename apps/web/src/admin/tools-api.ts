import type { AccountRole, RarityId, WorldProgress } from '@worldforge/game-core';
import { apiRequest, type ApiResult } from '../lib/api';
import type { InventoryDto, ItemDto } from '../game/api';

/**
 * Client side of the admin tools (ticket D.4, docs/API_CONVENTIONS.md "Admin tools"). Every route
 * answers 404 to non-admins. Every write carries an `Idempotency-Key` (pass the same key to retry
 * the same action) and a `reason`. Destructive writes also carry `confirm`: the hero's name, the
 * handle or the flag id, typed by the admin.
 */

export type ItemLocation = 'pack' | 'equipped' | 'warehouse' | 'shelf' | 'escrow';

/** A server item (`ItemDto`, render it with `toItemView`) and where it sits. */
export interface AdminItem extends ItemDto {
  location: ItemLocation;
  characterId: string;
  /** Why a removal would be refused right now. */
  removeBlocked: 'held' | 'escrow' | null;
}

export interface HeroFile {
  id: string;
  name: string;
  classId: string;
  level: number;
  experience: number;
  gold: number;
  progress: WorldProgress;
  warehouseLevel: number;
  createdAt: string;
  deleted: { at: string; restoreUntil: string; reason: string; restorable: boolean } | null;
  activity: { areaId: string; settledAt: string; lastSeenAt: string } | null;
  materials: Record<string, number>;
  professions: { professionId: string; level: number; experience: number }[];
  items: AdminItem[];
  quests: {
    id: string;
    kind: 'story' | 'contract';
    questId: string;
    status: 'active' | 'turnedIn';
    contractDay: string | null;
    progress: number[];
    objectives: unknown[];
  }[];
  defence: { bracketId: string; level: number } | null;
  holds: { gold: number; materials: Record<string, number>; items: number; heldUntil: string }[];
  daily: { ratedDuels: number; contracts: number; contractsPerDay: number; merchantBought: number };
}

export interface AccountFile {
  handle: string;
  displayName: string;
  role: AccountRole;
  createdAt: string;
  testAccount: boolean;
  /** Only "verified yes/no": the address itself never leaves the server. */
  emailVerified: boolean;
  characterSlots: number;
  sessions: number;
  loginLockedForMs: number;
  shelf: { gold: number; materials: Record<string, number>; items: AdminItem[] };
  heroes: HeroFile[];
  sanctions: {
    id: string;
    kind: string;
    reason: string;
    createdAt: string;
    expiresAt: string;
    liftedAt: string | null;
    active: boolean;
  }[];
  offers: {
    id: string;
    direction: 'sent' | 'received';
    counterpart: { handle: string; displayName: string } | null;
    status: string;
    expiresAt: string;
    createdAt: string;
  }[];
  audit: { id: string; event: string; at: string; heroName: string | null; data: unknown }[];
  /** The viewing admin's own account (cheat tools on it show on public boards). */
  own: boolean;
}

export interface GrantSpec {
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  variant: 'void' | null;
  upgradeLevel: number;
}

/** The generated item a grant would create (a game-core `GeneratedItem` plus its upgrade level). */
export interface PreviewItem {
  seed: number;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: { affixId: string; tier: number; value: number }[];
  effectId?: string;
  effectRoll?: number;
  setId?: string;
  mythicId?: string;
  variant?: 'void';
  upgradeLevel: number;
}

export type CurrencyMode = 'grant' | 'refund' | 'remove';
export type DailyLimit = 'ratedDuels' | 'contracts' | 'merchant';

/** Present on a cheat tool's answer when it ran on the admin's own, non-test account. */
export interface CheatAnswer {
  warning?: 'public_boards';
}

export interface WorldView {
  gameNow: string;
  flags: { id: string; set: boolean; setAt: string | null; projectId: string | null }[];
  scheduler: {
    running: boolean;
    intervalMs: number;
    lastTickAt: string | null;
    nextTickAt: string | null;
    jobs: { job: string; lastRunAt: string | null; ok: boolean | null; detail: string | null }[];
  };
  seasons: {
    current: { number: number; endsAt: string } | null;
    next: { number: number; startsAt: string } | null;
    pendingArchive: number;
  };
  deletedHeroes: { total: number; purgeDue: number };
}

export interface HeroViewAs {
  readOnly: true;
  deleted: boolean;
  character: {
    id: string;
    name: string;
    classId: string;
    level: number;
    experience: number;
    gold: number;
  };
  inventory: InventoryDto;
  warehouse: AdminItem[];
  materials: Record<string, number>;
  activity: { areaId: string; settledAt: string; summary: unknown } | null;
  areas: { id: string; unlocked: boolean }[];
  dungeons: { id: string; tier: number; unlocked: boolean }[];
}

const enc = encodeURIComponent;
const get = <T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>> =>
  apiRequest<T>(path, signal ? { signal } : {});
const post = <T>(path: string, key: string, body: object): Promise<ApiResult<T>> =>
  apiRequest<T>(path, { method: 'POST', body, headers: { 'Idempotency-Key': key } });
const hero = (handle: string, characterId: string) =>
  `/admin/accounts/${enc(handle)}/heroes/${enc(characterId)}`;

/** A fresh key per action (reuse it to retry the same action). */
export const newActionKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const toolsApi = {
  account: (handle: string, signal?: AbortSignal) =>
    get<{ account: AccountFile }>(`/admin/accounts/${enc(handle)}`, signal),
  viewAs: (handle: string, characterId: string, signal?: AbortSignal) =>
    get<HeroViewAs>(`${hero(handle, characterId)}/view`, signal),
  previewItem: (handle: string, characterId: string, spec: GrantSpec & { seed?: number }) =>
    apiRequest<{ seed: number; item: PreviewItem }>(`${hero(handle, characterId)}/items/preview`, {
      method: 'POST',
      body: spec,
    }),
  grantItem: (
    handle: string,
    characterId: string,
    key: string,
    spec: GrantSpec & { seed: number; reason: string },
  ) =>
    post<{ item: AdminItem } & CheatAnswer>(`${hero(handle, characterId)}/items/grant`, key, spec),
  removeItem: (
    handle: string,
    itemId: string,
    key: string,
    b: { confirm: string; reason: string },
  ) =>
    post<{ removed: { itemId: string; location: ItemLocation; characterId: string } }>(
      `/admin/accounts/${enc(handle)}/items/${enc(itemId)}/remove`,
      key,
      b,
    ),
  gold: (
    handle: string,
    characterId: string,
    key: string,
    b: { mode: CurrencyMode; amount: number; confirm?: string; reason: string },
  ) =>
    post<{ gold: { before: number; after: number } } & CheatAnswer>(
      `${hero(handle, characterId)}/gold`,
      key,
      b,
    ),
  materials: (
    handle: string,
    characterId: string,
    key: string,
    b: { mode: CurrencyMode; materials: Record<string, number>; confirm?: string; reason: string },
  ) =>
    post<
      { materials: { before: Record<string, number>; after: Record<string, number> } } & CheatAnswer
    >(`${hero(handle, characterId)}/materials`, key, b),
  xp: (handle: string, characterId: string, key: string, b: { xp: number; reason: string }) =>
    post<
      {
        before: { level: number; experience: number };
        after: { level: number; experience: number };
      } & CheatAnswer
    >(`${hero(handle, characterId)}/xp`, key, b),
  level: (handle: string, characterId: string, key: string, b: { level: number; reason: string }) =>
    post<{ before: { level: number }; after: { level: number } } & CheatAnswer>(
      `${hero(handle, characterId)}/level`,
      key,
      b,
    ),
  deleteHero: (
    handle: string,
    characterId: string,
    key: string,
    b: { confirm: string; reason: string },
  ) =>
    post<{
      deleted: {
        characterId: string;
        name: string;
        restoreUntil: string;
        offersVoided: number;
        shelfItemsRehomed: number;
        leaderboardRowsRemoved: number;
        defence: boolean;
      };
    }>(`${hero(handle, characterId)}/delete`, key, b),
  restoreHero: (handle: string, characterId: string, key: string, b: { reason: string }) =>
    post<{
      restored: {
        characterId: string;
        name: string;
        defenceRestored: boolean;
        activeRestored: boolean;
        showcaseRestored: boolean;
        notRestored: {
          offersVoided: number;
          shelfItemsRehomed: number;
          activityAreaId: string | null;
        };
      };
    }>(`${hero(handle, characterId)}/restore`, key, b),
  renameHero: (
    handle: string,
    characterId: string,
    key: string,
    b: { name: string; reason: string },
  ) =>
    post<{ renamed: { from: string; to: string } }>(`${hero(handle, characterId)}/rename`, key, b),
  progress: (
    handle: string,
    characterId: string,
    key: string,
    b: {
      gravewardenDefeated: boolean;
      cryptTierCleared: number;
      ashenWardenDefeated: boolean;
      reason: string;
    },
  ) =>
    post<{ before: WorldProgress; after: WorldProgress } & CheatAnswer>(
      `${hero(handle, characterId)}/progress`,
      key,
      b,
    ),
  professions: (
    handle: string,
    characterId: string,
    key: string,
    b: { professions: Record<string, number>; reason: string },
  ) =>
    post<{ professions: Record<string, number> } & CheatAnswer>(
      `${hero(handle, characterId)}/professions`,
      key,
      b,
    ),
  dailyReset: (
    handle: string,
    characterId: string,
    key: string,
    b: { limits: DailyLimit[]; reason: string },
  ) =>
    post<{ reset: Partial<Record<DailyLimit, number>> } & CheatAnswer>(
      `${hero(handle, characterId)}/daily-reset`,
      key,
      b,
    ),
  quest: (
    handle: string,
    characterId: string,
    questRowId: string,
    action: 'complete' | 'reset',
    key: string,
    b: { reason: string },
  ) =>
    post<{ quest: { id: string; questId: string; action: string } } & CheatAnswer>(
      `${hero(handle, characterId)}/quests/${enc(questRowId)}/${action}`,
      key,
      b,
    ),
  fastForward: (
    handle: string,
    characterId: string,
    key: string,
    b: { minutes: number; reason: string },
  ) =>
    post<
      {
        minutes: number;
        creditedMs: number;
        before: { level: number; experience: number; gold: number };
        after: { level: number; experience: number; gold: number };
      } & CheatAnswer
    >(`${hero(handle, characterId)}/fast-forward`, key, b),
  revokeSessions: (handle: string, key: string, b: { confirm: string; reason: string }) =>
    post<{ revoked: number }>(`/admin/accounts/${enc(handle)}/sessions/revoke`, key, b),
  clearLoginLock: (handle: string, key: string, b: { reason: string }) =>
    post<{ wasLockedForMs: number }>(`/admin/accounts/${enc(handle)}/login-lock/clear`, key, b),
  world: (signal?: AbortSignal) => get<WorldView>('/admin/world', signal),
  setWorldFlag: (
    flagId: string,
    key: string,
    b: { set: boolean; confirm: string; reason: string },
  ) =>
    post<{ flagId: string; before: boolean; after: boolean }>(
      `/admin/world/flags/${enc(flagId)}`,
      key,
      b,
    ),
};
