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
import { authApi, type Account, type LoginInput, type RegisterInput } from './api';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; account: Account }
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    authApi.current(controller.signal).then(
      (res) => {
        if (res.ok) setState({ kind: 'authenticated', account: res.value.account });
        else if (res.error.status === 401) setState({ kind: 'anonymous' });
        else setState({ kind: 'error', message: res.error.message });
      },
      () => {
        /* aborted on unmount */
      },
    );
    return () => controller.abort();
  }, [attempt]);

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

  const value = useMemo(
    () => ({ state, login, register, logout, retry }),
    [state, login, register, logout, retry],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
