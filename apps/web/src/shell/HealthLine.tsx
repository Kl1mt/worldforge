import { useHealthPoll } from './healthPoll';

/**
 * Server connection line: covers the loading, success and error states. Ticket F.4: it reads
 * the shared health poll, which also carries the server's version for the reload hint.
 */
export function HealthLine() {
  const { health: state } = useHealthPoll();

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
