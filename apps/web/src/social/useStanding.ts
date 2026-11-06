import { useCallback, useEffect, useState } from 'react';
import { socialApi, type Standing } from './api';
import type { ApiFailure } from '../lib/api';

export type StandingState =
  | { kind: 'loading' }
  | { kind: 'ready'; standing: Standing }
  | { kind: 'error'; error: ApiFailure };

/** The account's standing (ticket 4.1): active sanctions, read on mount and on `reload`. */
export function useStanding() {
  const [state, setState] = useState<StandingState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    socialApi.standing(controller.signal).then(
      (res) =>
        setState(
          res.ok ? { kind: 'ready', standing: res.value } : { kind: 'error', error: res.error },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
