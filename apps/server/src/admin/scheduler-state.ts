/**
 * Ticket D.4: what the in-process scheduler (app.ts `registerSettlementScheduler`) last did, for
 * the admin panel's World tab. In memory, like the scheduler itself (one API instance); a restart
 * starts empty. Holds job names, times and counts only.
 */
export type SchedulerJob =
  'settlement' | 'pruning' | 'leaderboardSweep' | 'seasonJobs' | 'eventJobs' | 'tradeSweep';

export const SCHEDULER_JOBS: readonly SchedulerJob[] = [
  'settlement',
  'pruning',
  'leaderboardSweep',
  'seasonJobs',
  // Ticket 6.6: ended events closed and their reward sweep.
  'eventJobs',
  'tradeSweep',
];

export interface SchedulerJobState {
  lastRunAt: string | null;
  ok: boolean | null;
  /** A short outcome, e.g. `settled 12` (never ids). */
  detail: string | null;
}

export class SchedulerState {
  intervalMs = 0;
  lastTickAt: Date | null = null;
  readonly jobs: Record<SchedulerJob, SchedulerJobState> = Object.fromEntries(
    SCHEDULER_JOBS.map((j) => [j, { lastRunAt: null, ok: null, detail: null }]),
  ) as Record<SchedulerJob, SchedulerJobState>;

  tick(at: Date): void {
    this.lastTickAt = at;
  }

  record(job: SchedulerJob, at: Date, ok: boolean, detail: string | null = null): void {
    this.jobs[job] = { lastRunAt: at.toISOString(), ok, detail };
  }

  /** The next tick, if the scheduler runs (an estimate: ticks skip while one is running). */
  nextTickAt(now: Date): string | null {
    if (this.intervalMs <= 0) return null;
    const from = this.lastTickAt ?? now;
    return new Date(from.getTime() + this.intervalMs).toISOString();
  }
}
