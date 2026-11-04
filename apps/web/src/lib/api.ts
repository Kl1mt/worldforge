/** Client side of the API error envelope (docs/API_CONVENTIONS.md). */
export interface ApiFailure {
  /** HTTP status, or 0 when the server could not be reached. */
  status: number;
  /** Stable machine code from the envelope (`network` / `bad_response` are client-side). */
  code: string;
  message: string;
  /** Per-field messages from `details.fields`, when the server sent them. */
  fields: Record<string, string>;
  retryAfterSeconds?: number;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

function readFailure(status: number, body: unknown): ApiFailure {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error.code !== 'string') {
    return { status, code: 'bad_response', message: `Server responded ${status}`, fields: {} };
  }
  const details = (error.details ?? {}) as { fields?: unknown; retryAfterSeconds?: unknown };
  const fields: Record<string, string> = {};
  if (details.fields && typeof details.fields === 'object') {
    for (const [k, v] of Object.entries(details.fields)) if (typeof v === 'string') fields[k] = v;
  }
  return {
    status,
    code: error.code,
    message: typeof error.message === 'string' ? error.message : error.code,
    fields,
    ...(typeof details.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: details.retryAfterSeconds }
      : {}),
  };
}

/**
 * JSON request to `/api`. Never throws for HTTP or network failures (only for an abort), so
 * callers handle every state through the result.
 */
export async function apiRequest<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return {
      ok: false,
      error: { status: 0, code: 'network', message: 'Server unreachable', fields: {} },
    };
  }
  if (res.status === 204) return { ok: true, value: undefined as T };
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: readFailure(res.status, body) };
  if (body === null) {
    return {
      ok: false,
      error: {
        status: res.status,
        code: 'bad_response',
        message: 'Unreadable response',
        fields: {},
      },
    };
  }
  return { ok: true, value: body as T };
}
