import { useEffect, useState } from 'react';
import { CLASSES } from '@worldforge/game-core';
import { fetchHealth, type HealthState } from './health';

function HealthLine({ state }: { state: HealthState }) {
  switch (state.kind) {
    case 'loading':
      return <p role="status">Server: checking…</p>;
    case 'ok':
      return <p role="status">Server: online (up {state.uptimeSeconds}s)</p>;
    case 'error':
      return <p role="alert">Server: offline — {state.message}</p>;
  }
}

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(fetch, controller.signal).then(setHealth, () => {
      /* aborted on unmount */
    });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Worldforge</h1>
      <p>Placeholder client. Visual design arrives in ticket 0.3.</p>
      <p>Classes: {CLASSES.map((c) => c.name).join(', ')}</p>
      <HealthLine state={health} />
    </main>
  );
}
