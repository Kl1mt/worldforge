import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getArea, type AreaId, type EquipmentSlotId, type StatBlock } from '@worldforge/game-core';
import { useAuth } from '../auth/AuthProvider';
import { useCharacters } from '../characters/CharactersProvider';
import type { Character } from '../characters/api';
import type { ApiFailure, ApiResult } from '../lib/api';
import {
  activityApi,
  describeGameFailure,
  inventoryApi,
  materialsApi,
  worldApi,
  type Activity,
  type InventoryDto,
  type MaterialsState,
  type ReturnSummary,
  type SettleResult,
  type WorldState,
} from './api';
import {
  appendChronicle,
  chronicleEntries,
  isWorthAReturnDialog,
  type LogEntry,
} from './chronicle';
import { toItemView, type ItemView } from './items';

/** How often the client asks the server to settle while farming (docs/FARMING.md: polling). */
export const SETTLE_POLL_MS = 8_000;
/** A hidden tab that comes back after this long counts as a return (summary dialog). */
const RETURN_AFTER_HIDDEN_MS = 60_000;

export type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; message: string };

export interface Inventory {
  equipped: ItemView[];
  items: ItemView[];
  stats: StatBlock;
}

/** Totals of what the server credited since this screen was opened (the area's pace line). */
export interface SessionTally {
  kills: number;
  items: number;
  simulatedMs: number;
}

interface GameContextValue {
  activity: Load<Activity | null>;
  /** Which places are open to the character (server-checked unlocks, ticket 2.2). */
  world: Load<WorldState>;
  /**
   * The area the Area screen shows: the fight in progress, else the last area farmed this
   * visit, else the Abandoned Fields.
   */
  areaId: AreaId;
  inventory: Load<Inventory>;
  /** Materials and professions (ticket 2.3), refreshed when a settlement gathers something. */
  materials: Load<MaterialsState>;
  chronicle: LogEntry[];
  tally: SessionTally;
  /** The summary to show in the return dialog, until dismissed. */
  returnSummary: ReturnSummary | null;
  dismissReturn: () => void;
  /** Start/stop in flight, and the last start/stop/settle failure to show. */
  farmBusy: boolean;
  farmError: string | null;
  /** Resolves to whether the server accepted the start or switch. */
  startFarming: (areaId: AreaId) => Promise<boolean>;
  stopFarming: () => Promise<void>;
  /** Item actions resolve to `null` on success or a sentence to show. */
  equip: (itemId: string, slot?: EquipmentSlotId) => Promise<string | null>;
  unequip: (itemId: string) => Promise<string | null>;
  discard: (itemId: string) => Promise<string | null>;
  /** Shows an inventory the server returned from another action (merchant, forge: ticket 2.6). */
  applyInventory: (dto: InventoryDto) => void;
  /** Re-reads materials after an action that changed them (forge: ticket 2.6). */
  refreshMaterials: () => void;
  reload: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

function toInventory(dto: InventoryDto): Inventory {
  return {
    equipped: dto.equipped.map(toItemView),
    items: dto.inventory.map(toItemView),
    stats: dto.stats,
  };
}

const EMPTY_TALLY: SessionTally = { kills: 0, items: 0, simulatedMs: 0 };

/**
 * Game state of the active character: activity, inventory, the Chronicle and the return summary.
 * The client only displays what the server returns and sends intents (start, stop, settle,
 * equip …); it never computes rewards. Mount it with `key={character.id}`.
 */
export function GameProvider({
  character,
  children,
}: {
  character: Character;
  children: ReactNode;
}) {
  const characterId = character.id;
  const { retry: recheckSession } = useAuth();
  const { updateCharacter } = useCharacters();
  const [attempt, setAttempt] = useState(0);
  const [activity, setActivity] = useState<Load<Activity | null>>({ kind: 'loading' });
  const [inventory, setInventory] = useState<Load<Inventory>>({ kind: 'loading' });
  const [world, setWorld] = useState<Load<WorldState>>({ kind: 'loading' });
  const [materials, setMaterials] = useState<Load<MaterialsState>>({ kind: 'loading' });
  const [lastAreaId, setLastAreaId] = useState<AreaId>('abandonedFields');
  const [chronicle, setChronicle] = useState<LogEntry[]>([]);
  const [tally, setTally] = useState<SessionTally>(EMPTY_TALLY);
  const [returnSummary, setReturnSummary] = useState<ReturnSummary | null>(null);
  const [farmBusy, setFarmBusy] = useState(false);
  const [farmError, setFarmError] = useState<string | null>(null);
  const seq = useRef(0);
  /** Area of the activity as last rendered, to notice a deferred switch arriving in a settle. */
  const shownArea = useRef<AreaId | null>(null);
  const settling = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Common failure handling: an ended session goes back to the gate. */
  const failed = useCallback(
    (error: ApiFailure): string => {
      if (error.status === 401) recheckSession();
      return describeGameFailure(error);
    },
    [recheckSession],
  );

  const loadInventory = useCallback(async () => {
    const res = await inventoryApi.get(characterId);
    if (!alive.current) return;
    if (res.ok) setInventory({ kind: 'ready', value: toInventory(res.value) });
    else setInventory({ kind: 'error', message: failed(res.error) });
  }, [characterId, failed]);

  const loadMaterials = useCallback(
    async (signal?: AbortSignal) => {
      const res = await materialsApi.get(characterId, signal ? { signal } : {});
      if (!alive.current) return;
      setMaterials((prev) =>
        res.ok
          ? { kind: 'ready', value: res.value }
          : // A failed refresh keeps the shown numbers; only a first load shows the error.
            prev.kind === 'ready'
            ? prev
            : { kind: 'error', message: failed(res.error) },
      );
    },
    [characterId, failed],
  );

  /** Records a settled summary: Chronicle, tally, character, and inventory if loot arrived. */
  const absorb = useCallback(
    (result: SettleResult, asReturn: boolean) => {
      const { summary } = result;
      seq.current += 1;
      const fresh = chronicleEntries(summary, seq.current);
      if (fresh.length > 0) setChronicle((log) => appendChronicle(log, fresh));
      setTally((t) => ({
        kills: t.kills + summary.kills,
        items: t.items + summary.itemsGained,
        simulatedMs: t.simulatedMs + summary.simulatedMs,
      }));
      updateCharacter(result.character);
      if (asReturn && isWorthAReturnDialog(summary)) setReturnSummary(summary);
      if (summary.itemsGained > 0 || summary.levelsGained > 0) void loadInventory();
      if (Object.keys(summary.materials ?? {}).length > 0) void loadMaterials();
    },
    [loadInventory, loadMaterials, updateCharacter],
  );

  const settle = useCallback(
    async (asReturn: boolean) => {
      if (settling.current) return;
      settling.current = true;
      try {
        const res = await activityApi.settle(characterId);
        if (!alive.current) return;
        if (res.ok) {
          const arrived = res.value.activity?.areaId;
          if (arrived && shownArea.current && arrived !== shownArea.current) {
            seq.current += 1;
            const note: LogEntry = {
              id: `${seq.current}:arrive`,
              at: res.value.summary.until,
              kind: 'note',
              text: `${res.value.character.name} arrives in ${getArea(arrived).name}.`,
            };
            setChronicle((log) => appendChronicle(log, [note]));
          }
          setActivity({ kind: 'ready', value: res.value.activity });
          setFarmError(null);
          absorb(res.value, asReturn);
        } else if (res.error.code === 'not_farming') {
          // Stopped elsewhere (another device, or another character started).
          setActivity({ kind: 'ready', value: null });
        } else {
          setFarmError(failed(res.error));
        }
      } finally {
        settling.current = false;
      }
    },
    [characterId, absorb, failed],
  );

  // Initial load: activity and inventory; a running activity is settled at once (the return).
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    inventoryApi.get(characterId, { signal }).then(
      (res) =>
        setInventory(
          res.ok
            ? { kind: 'ready', value: toInventory(res.value) }
            : { kind: 'error', message: failed(res.error) },
        ),
      () => {
        /* aborted */
      },
    );
    loadMaterials(signal).catch(() => {
      /* aborted */
    });
    activityApi.get(characterId, { signal }).then(
      (res) => {
        if (!res.ok) {
          setActivity({ kind: 'error', message: failed(res.error) });
          return;
        }
        setActivity({ kind: 'ready', value: res.value.activity });
        if (res.value.activity) void settle(true);
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt, characterId, settle, failed, loadMaterials]);

  // World state: on load, and again whenever the level changes (unlocks follow the level).
  const level = character.level;
  useEffect(() => {
    const controller = new AbortController();
    worldApi.get(characterId, { signal: controller.signal }).then(
      (res) =>
        setWorld((prev) =>
          res.ok
            ? { kind: 'ready', value: res.value }
            : // Keep a good map on a failed refresh; only a first load shows the error.
              prev.kind === 'ready'
              ? prev
              : { kind: 'error', message: failed(res.error) },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt, characterId, level, failed]);

  const farming = activity.kind === 'ready' && activity.value !== null;
  const currentAreaId = activity.kind === 'ready' ? activity.value?.areaId : undefined;
  const areaId = currentAreaId ?? lastAreaId;
  useEffect(() => {
    shownArea.current = currentAreaId ?? null;
  }, [currentAreaId]);

  // Poll while farming and visible; a long hidden spell counts as a return.
  useEffect(() => {
    if (!farming) return;
    let hiddenAt: number | null = null;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void settle(false);
    }, SETTLE_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null) {
        const away = Date.now() - hiddenAt;
        hiddenAt = null;
        void settle(away >= RETURN_AFTER_HIDDEN_MS);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [farming, settle]);

  const startFarming = useCallback(
    async (areaId: AreaId) => {
      setFarmBusy(true);
      setFarmError(null);
      const res = await activityApi.start(characterId, areaId);
      if (!alive.current) return false;
      setFarmBusy(false);
      if (!res.ok) {
        setFarmError(failed(res.error));
        return false;
      }
      const before = activity.kind === 'ready' ? activity.value : null;
      const next = res.value.activity;
      setActivity({ kind: 'ready', value: next });
      updateCharacter(res.value.character);
      const name = res.value.character.name;
      const target = getArea(areaId).name;
      let text: string | null;
      if (next?.pendingAreaId) {
        text = `${name} will set out for ${target} once this fight is over.`;
      } else if (before?.pendingAreaId && next?.areaId === before.areaId) {
        text = `${name} stays in ${getArea(next.areaId).name}.`;
      } else if (before?.areaId === next?.areaId) {
        text = null; // Already there.
      } else {
        text = before ? `${name} travels to ${target}.` : `${name} sets out for ${target}.`;
      }
      if (text === null) return true;
      seq.current += 1;
      setChronicle((log) =>
        appendChronicle(log, [
          {
            id: `${seq.current}:start`,
            at: new Date().toISOString(),
            kind: 'note',
            text,
          },
        ]),
      );
      return true;
    },
    [activity, characterId, failed, updateCharacter],
  );

  const stopFarming = useCallback(async () => {
    setFarmBusy(true);
    setFarmError(null);
    const res = await activityApi.stop(characterId);
    if (!alive.current) return;
    setFarmBusy(false);
    if (!res.ok) {
      if (res.error.code === 'not_farming') setActivity({ kind: 'ready', value: null });
      else setFarmError(failed(res.error));
      return;
    }
    absorb(res.value, false);
    setLastAreaId(areaId);
    setActivity({ kind: 'ready', value: null });
    seq.current += 1;
    setChronicle((log) =>
      appendChronicle(log, [
        {
          id: `${seq.current}:stop`,
          at: res.value.summary.until,
          kind: 'note',
          text: `${res.value.character.name} leaves ${getArea(areaId).name} to rest.`,
        },
      ]),
    );
  }, [characterId, absorb, failed, areaId]);

  const itemAction = useCallback(
    async (run: () => Promise<ApiResult<InventoryDto>>): Promise<string | null> => {
      const res = await run();
      if (!alive.current) return null;
      if (res.ok) {
        setInventory({ kind: 'ready', value: toInventory(res.value) });
        return null;
      }
      // Stale view (item gone, slot changed elsewhere): fetch the truth again.
      if (res.error.status === 404 || res.error.status === 409) void loadInventory();
      return failed(res.error);
    },
    [loadInventory, failed],
  );

  const equip = useCallback(
    (itemId: string, slot?: EquipmentSlotId) =>
      itemAction(() => inventoryApi.equip(characterId, itemId, slot)),
    [characterId, itemAction],
  );
  const unequip = useCallback(
    (itemId: string) => itemAction(() => inventoryApi.unequip(characterId, itemId)),
    [characterId, itemAction],
  );
  const discard = useCallback(
    (itemId: string) => itemAction(() => inventoryApi.discard(characterId, itemId)),
    [characterId, itemAction],
  );

  const applyInventory = useCallback(
    (dto: InventoryDto) => setInventory({ kind: 'ready', value: toInventory(dto) }),
    [],
  );
  const refreshMaterials = useCallback(() => void loadMaterials(), [loadMaterials]);

  const reload = useCallback(() => {
    setActivity({ kind: 'loading' });
    setWorld({ kind: 'loading' });
    setInventory({ kind: 'loading' });
    setMaterials({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  const dismissReturn = useCallback(() => setReturnSummary(null), []);

  const value = useMemo<GameContextValue>(
    () => ({
      activity,
      world,
      areaId,
      inventory,
      materials,
      chronicle,
      tally,
      returnSummary,
      dismissReturn,
      farmBusy,
      farmError,
      startFarming,
      stopFarming,
      equip,
      unequip,
      discard,
      applyInventory,
      refreshMaterials,
      reload,
    }),
    [
      activity,
      world,
      areaId,
      inventory,
      materials,
      chronicle,
      tally,
      returnSummary,
      dismissReturn,
      farmBusy,
      farmError,
      startFarming,
      stopFarming,
      equip,
      unequip,
      discard,
      applyInventory,
      refreshMaterials,
      reload,
    ],
  );
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
