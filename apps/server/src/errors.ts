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

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorBody('not_found', `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
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
