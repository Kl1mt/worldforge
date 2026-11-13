import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** Ticket 9.4: `GET /api/account/growth` (docs/ACCOUNTS.md "API"). */
export interface GrowthEntry {
  source: string;
  description: string;
  /** False for a slot no hero can earn yet (the town's next great work). */
  available: boolean;
  grantedAt: string | null;
}

export interface AccountGrowth {
  slots: { base: number; total: number; used: number; entries: GrowthEntry[] };
  offline: {
    baseMs: number;
    capMs: number;
    nextCapMs: number | null;
    stepsMs: number[];
    deeds: GrowthEntry[];
  };
}

/** The slot an earned slot grant opens, by its source (the 3rd, 4th, 5th…). */
export const SLOT_SOURCE_LABELS: Record<string, string> = {
  level28: 'A hero of renown',
  heroicCrypt: 'Heroic crypt',
  community: 'The town’s next great work',
  shop: 'From the shop',
};

export const accountGrowthApi = {
  get: (signal?: AbortSignal, f?: typeof fetch): Promise<ApiResult<AccountGrowth>> =>
    apiRequest('/account/growth', signal ? { signal } : {}, f),
};

export function describeGrowthFailure(error: Pick<ApiFailure, 'code'>): string {
  if (error.code === 'network') return 'The server can’t be reached. Try again in a moment.';
  if (error.code === 'rate_limited') return 'Too many requests. Wait a moment and try again.';
  return 'The muster ledger could not be read. Try again.';
}
