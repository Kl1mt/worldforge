import type { FastifyError, FastifyInstance } from 'fastify';

/** Error envelope returned by every failing `/api` request (see docs/API_CONVENTIONS.md). */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * A deliberate, client-facing failure: thrown from handlers and hooks, rendered by the error
 * handler as the standard envelope with this status, code and (optional) details.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Ticket 4.11: the first non-finite number in a validated request part (`1e309`, `Infinity` and
 * `-Infinity` pass Ajv's `integer`, even with a `maximum`, once coerced from a query string or
 * parsed from JSON), as a dotted path, or null.
 */
export function nonFinitePath(value: unknown, path = ''): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path || 'value';
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const found = nonFinitePath(v, path ? `${path}.${k}` : k);
      if (found) return found;
    }
  }
  return null;
}

/** The not-found handler's body (ticket 4.11: also sent by the staff scopes' catch-alls). */
export function notFoundBody(request: { method: string; url: string }) {
  return errorBody('not_found', `Route ${request.method} ${request.url} not found`);
}

export function registerErrorHandling(app: FastifyInstance): void {
  // Ticket 4.11: refuse non-finite numbers after validation, before any route work (they used to
  // reach the database as `Infinity` and answer 500).
  app.addHook('preHandler', async (request) => {
    for (const part of ['query', 'params', 'body'] as const) {
      const at = nonFinitePath(request[part]);
      if (at) {
        throw new ApiError(400, 'validation_failed', `${part} ${at} must be a finite number.`, {
          fields: { [at]: 'Must be a finite number.' },
        });
      }
    }
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(notFoundBody(request));
  });

  app.setErrorHandler((err: FastifyError | ApiError, request, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err.validation) {
      return reply.code(400).send(errorBody('validation_failed', err.message, err.validation));
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send(errorBody('internal_error', 'Internal server error'));
    }
    return reply.code(status).send(errorBody(err.code ?? 'request_error', err.message));
  });
}
