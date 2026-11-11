import type { DatabaseHandle, DbSession } from '../db/types.js';

/**
 * Scheduler leader election (ticket 6.9, docs/DEPLOY.md "Running two API instances"). Every API
 * instance runs the scheduler's timer, but each job runs on exactly one: the instance holding the
 * job's **session advisory lock** (`pg_try_advisory_lock(namespace, job)`) on a dedicated
 * connection of its own (not a pooled one, so the lock lives exactly as long as that connection).
 *
 * - **Taking the lead:** before each run, an instance that does not hold the job's lock tries it
 *   (`try`: never waits). One instance gets it; the others skip the job ("standby").
 * - **Keeping it:** the holder checks its connection (`select 1`) before each run; while the
 *   connection lives, PostgreSQL keeps the lock for it.
 * - **Failover:** when the leader dies or its connection drops, PostgreSQL ends the session and
 *   frees the lock; the next tick of another instance takes it. The old leader, if alive, sees the
 *   error, drops the connection and competes again as a standby. A dead host's connection is ended
 *   by TCP keepalive (on) or PostgreSQL's own timeouts.
 * - **Jobs stay idempotent** (settlement by state, sweeps by cursor and conditions, season and event
 *   jobs by flags, pruning by time), so the short window in which a dropped leader finishes a run it
 *   began while another instance takes over costs at most a repeated, harmless run.
 *
 * A database without separate sessions (PGlite: one process, tests and the playtest server)
 * always leads.
 */
export const SCHEDULER_LOCK_NAMESPACE = 0x57460069;

/** One lock id per job (the second key of the advisory lock); never reuse a number. */
export const LEADER_JOBS = {
  settlement: 1,
  pruning: 2,
  leaderboardSweep: 3,
  seasonJobs: 4,
  eventJobs: 5,
  tradeSweep: 6,
  /** The start-up data backfills (T.1's binding, 6.5c's awaken lock, 6.9's name skeletons). */
  backfills: 7,
} as const;
export type LeaderJob = keyof typeof LEADER_JOBS;

interface Log {
  warn: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
}

export class SchedulerLeader {
  private session: DbSession | null = null;
  private connecting: Promise<DbSession | null> | null = null;
  private readonly held = new Set<LeaderJob>();
  private closed = false;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly log?: Log,
  ) {}

  /** Whether this instance may run `job` now (taking its lock if free). Never throws. */
  async lead(job: LeaderJob): Promise<boolean> {
    if (!this.handle.session) return true;
    if (this.closed) return false;
    const s = await this.connect();
    if (!s) return false;
    try {
      if (this.held.has(job)) {
        await s.query('select 1');
        return true;
      }
      const [row] = await s.query('select pg_try_advisory_lock($1::int, $2::int) as ok', [
        SCHEDULER_LOCK_NAMESPACE,
        LEADER_JOBS[job],
      ]);
      if (row?.ok === true) {
        this.held.add(job);
        this.log?.info({ job }, 'scheduler: this instance now leads the job');
        return true;
      }
      return false;
    } catch (err) {
      this.drop(s, err);
      return false;
    }
  }

  /** Gives up a job's lead (the start-up backfills, once done). */
  async release(job: LeaderJob): Promise<void> {
    const s = this.session;
    if (!s || !this.held.has(job)) return;
    this.held.delete(job);
    await s
      .query('select pg_advisory_unlock($1::int, $2::int)', [
        SCHEDULER_LOCK_NAMESPACE,
        LEADER_JOBS[job],
      ])
      .catch((err: unknown) => this.drop(s, err));
  }

  /** Runs `fn` if this instance gets the job's lead, then gives it up. Returns whether it ran. */
  async runOnce(job: LeaderJob, fn: () => Promise<void>): Promise<boolean> {
    if (!(await this.lead(job))) return false;
    try {
      await fn();
    } finally {
      await this.release(job);
    }
    return true;
  }

  /** The jobs this instance holds (tests, logs). */
  leading(): LeaderJob[] {
    return [...this.held];
  }

  /** The dedicated connection's backend pid (tests drop it to simulate a lost leader). */
  async backendPid(): Promise<number | null> {
    const s = await this.connect();
    if (!s) return null;
    const [row] = await s.query('select pg_backend_pid() as pid');
    return Number(row?.pid);
  }

  async close(): Promise<void> {
    this.closed = true;
    const s = this.session;
    this.session = null;
    this.held.clear();
    await s?.end().catch(() => undefined);
  }

  private async connect(): Promise<DbSession | null> {
    if (this.session) return this.session;
    if (!this.handle.session || this.closed) return null;
    this.connecting ??= this.handle
      .session()
      .then((s) => {
        s.onError((err) => this.drop(s, err));
        this.session = s;
        return s;
      })
      .catch((err: unknown) => {
        this.log?.warn({ err }, 'scheduler: leader connection failed');
        return null;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private drop(s: DbSession, err: unknown): void {
    if (this.session !== s) return;
    if (this.held.size > 0)
      this.log?.warn({ err, jobs: [...this.held] }, 'scheduler: lost the leader connection');
    this.session = null;
    this.held.clear();
    void s.end().catch(() => undefined);
  }
}
