import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresDatabase } from './client.js';

describe('createPostgresDatabase', () => {
  it('survives idle connection errors instead of crashing the process', async () => {
    const onIdleError = vi.fn();
    // Nothing listens on port 1; the pool connects lazily, so creation itself succeeds.
    const database = createPostgresDatabase({ url: 'postgres://u:p@127.0.0.1:1/db', onIdleError });
    const pool = (database.db as unknown as { $client: Pool }).$client;
    pool.emit('error', new Error('terminating connection due to administrator command'));
    expect(onIdleError).toHaveBeenCalledOnce();
    await expect(database.ping(2000)).rejects.toThrow();
    await database.close();
  });
});
