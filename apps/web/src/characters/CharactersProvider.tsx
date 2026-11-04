import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ApiFailure } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { charactersApi, type Character, type CreateCharacterInput, type Roster } from './api';

export type RosterState =
  /** No account yet (logged out), so there is nothing to load. */
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; roster: Roster }
  | { kind: 'error'; message: string };

interface CharactersContextValue {
  state: RosterState;
  /** The selected character, once the roster is loaded and one is active. */
  active: Character | null;
  /** Resolve to `null` on success (the new character is active), or the failure to show. */
  create: (input: CreateCharacterInput) => Promise<ApiFailure | null>;
  select: (id: string) => Promise<ApiFailure | null>;
  reload: () => void;
  /** Replaces a character with the server's newer copy (e.g. gold and XP after a settlement). */
  updateCharacter: (character: Character) => void;
}

const IDLE: RosterState = { kind: 'idle' };
const LOADING: RosterState = { kind: 'loading' };

const CharactersContext = createContext<CharactersContextValue | null>(null);

export function CharactersProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const accountId = auth.state.kind === 'authenticated' ? auth.state.account.id : null;
  // Results are tagged with the account and attempt they were loaded for, so a stale result (or
  // none yet) reads as `loading` without resetting state inside the effect.
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; state: RosterState } | null>(null);
  const key = accountId ? `${accountId}:${attempt}` : null;
  const state = useMemo<RosterState>(() => {
    if (!key || !accountId) return IDLE;
    if (loaded?.key === key) return loaded.state;
    // A reload of a loaded roster keeps showing it until the fresh one arrives.
    if (loaded?.state.kind === 'ready' && loaded.key.startsWith(`${accountId}:`)) {
      return loaded.state;
    }
    return LOADING;
  }, [key, accountId, loaded]);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    charactersApi.list(controller.signal).then(
      (res) =>
        setLoaded({
          key,
          state: res.ok
            ? { kind: 'ready', roster: res.value }
            : { kind: 'error', message: res.error.message },
        }),
      () => {
        /* aborted on unmount or account change */
      },
    );
    return () => controller.abort();
  }, [key]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /** Applies a local change to a loaded roster (after a successful create or select). */
  const patchRoster = useCallback((patch: (r: Roster) => Roster) => {
    setLoaded((l) =>
      l && l.state.kind === 'ready'
        ? { key: l.key, state: { kind: 'ready', roster: patch(l.state.roster) } }
        : l,
    );
  }, []);

  const create = useCallback(
    async (input: CreateCharacterInput) => {
      const res = await charactersApi.create(input);
      if (!res.ok) return res.error;
      const { character } = res.value;
      patchRoster((r) => ({
        characters: [...r.characters, character],
        slots: { ...r.slots, used: r.slots.used + 1 },
        activeCharacterId: character.id,
      }));
      return null;
    },
    [patchRoster],
  );

  const select = useCallback(
    async (id: string) => {
      const res = await charactersApi.select(id);
      if (!res.ok) {
        // The roster is stale (e.g. changed on another device): fetch it again.
        if (res.error.status === 403 || res.error.status === 404) reload();
        return res.error;
      }
      patchRoster((r) => ({ ...r, activeCharacterId: id }));
      return null;
    },
    [reload, patchRoster],
  );

  const updateCharacter = useCallback(
    (character: Character) =>
      patchRoster((r) => ({
        ...r,
        characters: r.characters.map((c) => (c.id === character.id ? character : c)),
      })),
    [patchRoster],
  );

  const active =
    state.kind === 'ready'
      ? (state.roster.characters.find((c) => c.id === state.roster.activeCharacterId) ?? null)
      : null;

  const value = useMemo(
    () => ({ state, active, create, select, reload, updateCharacter }),
    [state, active, create, select, reload, updateCharacter],
  );
  return <CharactersContext.Provider value={value}>{children}</CharactersContext.Provider>;
}

export function useCharacters(): CharactersContextValue {
  const ctx = useContext(CharactersContext);
  if (!ctx) throw new Error('useCharacters must be used inside <CharactersProvider>');
  return ctx;
}

/** The active character inside the game shell, where the route guard guarantees one. */
export function useActiveCharacter(): Character {
  const { active } = useCharacters();
  if (!active) throw new Error('useActiveCharacter needs an active character');
  return active;
}
