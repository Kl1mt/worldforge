import { useEffect, useState } from 'react';
import { fetchHealth, type HealthState } from '../health';

/** Server connection line: covers the loading, success and error states. */
export function HealthLine() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(fetch, controller.signal).then(setState, () => {
      /* aborted on unmount */
    });
    return () => controller.abort();
  }, []);

  switch (state.kind) {
    case 'loading':
      return (
        <p className="health health--loading" role="status">
          <span className="health__dot" aria-hidden="true" /> Reaching the server…
        </p>
      );
    case 'ok':
      return (
        <p className="health health--ok" role="status">
          <span className="health__dot" aria-hidden="true" /> Server online
        </p>
      );
    case 'error':
      return (
        <p className="health health--error" role="alert">
          <span className="health__dot" aria-hidden="true" /> Server offline: {state.message}
        </p>
      );
  }
}
