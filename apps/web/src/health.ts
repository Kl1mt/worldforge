export type HealthState =
  { kind: 'loading' } | { kind: 'ok'; uptimeSeconds: number } | { kind: 'error'; message: string };

export async function fetchHealth(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HealthState> {
  try {
    const res = await fetchImpl('/api/health', signal ? { signal } : {});
    if (!res.ok) return { kind: 'error', message: `Server responded ${res.status}` };
    const body = (await res.json()) as { status?: unknown; uptimeSeconds?: unknown };
    if (body.status !== 'ok' || typeof body.uptimeSeconds !== 'number') {
      return { kind: 'error', message: 'Unexpected health response' };
    }
    return { kind: 'ok', uptimeSeconds: body.uptimeSeconds };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { kind: 'error', message: 'Server unreachable' };
  }
}
