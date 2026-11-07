export type HealthState =
  | { kind: 'loading' }
  /** `version`: the game version the server runs (ticket F.3), when it sent a string. */
  | { kind: 'ok'; uptimeSeconds: number; version?: string }
  | { kind: 'error'; message: string };

export async function fetchHealth(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HealthState> {
  try {
    const res = await fetchImpl('/api/health', signal ? { signal } : {});
    if (!res.ok) return { kind: 'error', message: `Server responded ${res.status}` };
    const body = (await res.json()) as {
      status?: unknown;
      uptimeSeconds?: unknown;
      version?: unknown;
    };
    if (body.status !== 'ok' || typeof body.uptimeSeconds !== 'number') {
      return { kind: 'error', message: 'Unexpected health response' };
    }
    return typeof body.version === 'string'
      ? { kind: 'ok', uptimeSeconds: body.uptimeSeconds, version: body.version }
      : { kind: 'ok', uptimeSeconds: body.uptimeSeconds };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { kind: 'error', message: 'Server unreachable' };
  }
}
