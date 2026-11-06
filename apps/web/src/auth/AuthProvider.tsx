import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { SUSPENDED_EVENT, type ApiFailure } from '../lib/api';
import { sanctionOf, type Sanction } from '../social/api';
import {
  authApi,
  type Account,
  type GuideUpdate,
  type LoginInput,
  type RegisterInput,
} from './api';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; account: Account }
  /** Ticket 4.1: the account is suspended; every request answers 403 until it expires. */
  | { kind: 'suspended'; sanction: Sanction }
  /** The session check itself failed (server down); we do not know who the visitor is. */
  | { kind: 'error'; message: string };

interface AuthContextValue {
  state: AuthState;
  /** Resolve to `null` on success (state becomes authenticated), or the failure to show. */
  login: (input: LoginInput) => Promise<ApiFailure | null>;
  register: (input: RegisterInput) => Promise<ApiFailure | null>;
  logout: () => Promise<ApiFailure | null>;
  /** Re-run the session check after an `error` state. */
  retry: () => void;
  /**
   * Records a first-session guide change (ticket 2.7). Optimistic: the account shows it at
   * once; the server's answer replaces it. A failure is ignored (the guide is a convenience).
   */
  updateGuide: (update: GuideUpdate) => void;
  /** Re-reads the account (after a forced rename, ticket 4.1). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    authApi.current(controller.signal).then(
      (res) => {
        const sanction = res.ok ? null : sanctionOf(res.error);
        if (res.ok) setState({ kind: 'authenticated', account: res.value.account });
        else if (res.error.status === 401) setState({ kind: 'anonymous' });
        else if (res.error.code === 'account_suspended' && sanction) {
          setState({ kind: 'suspended', sanction });
        } else setState({ kind: 'error', message: res.error.message });
      },
      () => {
        /* aborted on unmount */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  // Any request that finds the account suspended (ticket 4.1) closes the game at once.
  useEffect(() => {
    const onSuspended = (e: Event) => {
      const sanction = sanctionOf((e as CustomEvent<unknown>).detail);
      if (sanction) setState({ kind: 'suspended', sanction });
    };
    window.addEventListener(SUSPENDED_EVENT, onSuspended);
    return () => window.removeEventListener(SUSPENDED_EVENT, onSuspended);
  }, []);

  const refresh = useCallback(async () => {
    const res = await authApi.current();
    if (res.ok) setState({ kind: 'authenticated', account: res.value.account });
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const res = await authApi.login(input);
    if (!res.ok) return res.error;
    setState({ kind: 'authenticated', account: res.value.account });
    return null;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const res = await authApi.register(input);
    if (!res.ok) return res.error;
    setState({ kind: 'authenticated', account: res.value.account });
    return null;
  }, []);

  const logout = useCallback(async () => {
    const res = await authApi.logout();
    if (!res.ok) return res.error;
    setState({ kind: 'anonymous' });
    return null;
  }, []);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const updateGuide = useCallback((update: GuideUpdate) => {
    setState((prev) => {
      if (prev.kind !== 'authenticated') return prev;
      const g = prev.account.guide;
      const guide =
        'step' in update
          ? g.steps.includes(update.step)
            ? g
            : { ...g, steps: [...g.steps, update.step] }
          : { ...g, dismissed: update.dismissed };
      return guide === g ? prev : { ...prev, account: { ...prev.account, guide } };
    });
    void authApi.guide(update).then((res) => {
      if (!res.ok) return;
      setState((prev) => {
        if (prev.kind !== 'authenticated' || prev.account.id !== res.value.account.id) return prev;
        // Answers can arrive out of order: keep steps an earlier answer already confirmed, and
        // let only a dismiss/reopen answer change `dismissed` (a late step answer must not
        // reopen a guide the player just closed).
        const server = res.value.account.guide;
        const local = prev.account.guide;
        const guide = {
          steps: [...new Set([...local.steps, ...server.steps])],
          dismissed: 'dismissed' in update ? server.dismissed : local.dismissed,
        };
        return { ...prev, account: { ...res.value.account, guide } };
      });
    });
  }, []);

  const value = useMemo(
    () => ({ state, login, register, logout, retry, updateGuide, refresh }),
    [state, login, register, logout, retry, updateGuide, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
