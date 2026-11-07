import type { AccountRole, ClassId, ReportTarget, SanctionKind } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { SeasonList } from '../social/seasons';

/** Client side of `/api/admin/*` (ticket D.3). Every route answers 404 to non-admins. */

export interface PlayerRef {
  handle: string;
  displayName: string;
}

export type InviteStatus = 'active' | 'used_up' | 'expired' | 'revoked';

export interface AdminInvite {
  id: string;
  status: InviteStatus;
  uses: number;
  maxUses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  note: string;
  createdAt: string;
  /** Null: created with the CLI (or by a deleted account). */
  createdBy: PlayerRef | null;
  redeemedBy: (PlayerRef & { registeredAt: string })[];
}

export interface InviteInput {
  maxUses: number;
  /** Null: never expires. */
  expiresInHours: number | null;
  note: string;
}

export interface TelemetryTable {
  headers: string[];
  rows: (string | number)[][];
}

export interface TelemetrySection {
  title: string;
  tables: TelemetryTable[];
  notes: string[];
}

export interface TelemetryReport {
  window: {
    from: string | null;
    to: string | null;
    firstDay: string | null;
    lastDay: string | null;
    days: number;
  };
  snapshot: {
    equippedCharacters: number;
    usage: {
      classId: string;
      kind: 'base' | 'effect' | 'set' | 'variant';
      id: string;
      equipped: number;
    }[];
    builds: { classId: string; signature: string; characters: number }[];
  };
  reconcile?: { check: string; audit: number; rollup: number; ok: boolean }[];
}

export interface PlayerRow extends PlayerRef {
  role: AccountRole;
  createdAt: string;
}

export interface PlayerSanction {
  id: string;
  kind: SanctionKind;
  status: 'active' | 'expired' | 'lifted';
  reason: string;
  target: ReportTarget | null;
  createdAt: string;
  expiresAt: string;
  liftedAt: string | null;
  liftReason: string | null;
  issuedBy: PlayerRef | null;
  liftedBy: PlayerRef | null;
}

export interface PlayerReport {
  id: string;
  target: ReportTarget;
  reason: string;
  note: string | null;
  status: 'open' | 'dismissed' | 'actioned';
  createdAt: string;
  resolvedAt: string | null;
  reporter: PlayerRef | null;
  resolvedBy: PlayerRef | null;
}

export interface PlayerFile extends PlayerRow {
  registration: { at: string; invite: { id: string; note: string | null } | null } | null;
  characters: { name: string; classId: ClassId; level: number; createdAt: string }[];
  sanctions: PlayerSanction[];
  reports: PlayerReport[];
  reportsTruncated: boolean;
  actionable: boolean;
}

export interface ServerStatus {
  build: { gitSha: string | null; buildTime: string | null };
  startedAt: string;
  uptimeSeconds: number;
  db: { status: 'up' | 'down'; latencyMs: number | null };
  registrationMode: 'open' | 'invite' | 'closed';
  counts: { accounts: number; characters: number; active24h: number; active7d: number } | null;
  migrations: {
    available: number;
    applied: number;
    latest: string | null;
    pending: string[];
  } | null;
  /** Ticket 4.6: community project progress (aggregates only); absent on older servers. */
  projects?:
    | {
        id: string;
        name: string;
        status: 'locked' | 'open' | 'complete';
        stage: number;
        stages: number;
        completedOn: string | null;
        contributors: number;
        current: { resource: string; delivered: number; required: number }[];
      }[]
    | null;
}

export interface StaffMember extends PlayerRef {
  role: AccountRole;
  accountCreatedAt: string;
  grantedAt: string | null;
}

const get = <T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>> =>
  apiRequest<T>(path, signal ? { signal } : {});

export const adminApi = {
  invites: (signal?: AbortSignal) =>
    get<{ invites: AdminInvite[]; nextCursor: string | null }>('/admin/invites?limit=200', signal),
  createInvite: (input: InviteInput) =>
    apiRequest<{ code: string; invite: AdminInvite }>('/admin/invites', {
      method: 'POST',
      body: input,
    }),
  revokeInvite: (id: string) =>
    apiRequest<{ invite: AdminInvite; changed: boolean }>(
      `/admin/invites/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', body: {} },
    ),
  telemetry: (q: { from: string; to: string; reconcile: boolean }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    if (q.reconcile) params.set('reconcile', 'true');
    const qs = params.toString();
    return get<{ report: TelemetryReport; sections: TelemetrySection[] }>(
      `/admin/telemetry${qs ? `?${qs}` : ''}`,
      signal,
    );
  },
  searchPlayers: (query: string) =>
    apiRequest<{ players: PlayerRow[]; truncated: boolean; limit: number }>(
      '/admin/players/search',
      { method: 'POST', body: { query } },
    ),
  player: (handle: string, signal?: AbortSignal) =>
    get<{ player: PlayerFile }>(`/admin/players/${encodeURIComponent(handle)}`, signal),
  status: (signal?: AbortSignal) => get<ServerStatus>('/admin/status', signal),
  roles: (signal?: AbortSignal) => get<{ staff: StaffMember[] }>('/admin/roles', signal),
  // Ticket 5.3: the season plan.
  seasons: (signal?: AbortSignal) => get<AdminSeasons>('/admin/seasons', signal),
  scheduleSeason: (input: { startsAt: string; endsAt: string }) =>
    apiRequest<AdminSeasons>('/admin/seasons', { method: 'POST', body: input }),
  /** `endsAt` omitted: end the season now. */
  endSeason: (number: number, endsAt?: string) =>
    apiRequest<AdminSeasons>(`/admin/seasons/${number}/end`, {
      method: 'POST',
      body: endsAt ? { endsAt } : {},
    }),
};

/** Ticket 5.3: the admin panel's season view (`GET /api/admin/seasons`). */
export interface AdminSeasons extends SeasonList {
  counts: { season: number; entries: number; standings: number; awards: number }[];
}

/** The register link an invite code opens (D.2's hash form), on this site's own address. */
export function inviteLink(code: string, origin: string): string {
  return `${origin}/#/register?invite=${code}`;
}

export function describeAdminFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'network':
      return 'The server cannot be reached.';
    case 'not_found':
      return 'Not found. If your admin role was just revoked, reload the page.';
    case 'validation_failed':
      return error.message;
    case 'rate_limited': {
      const s = error.retryAfterSeconds ?? 60;
      return `Too many requests. Try again in ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`}.`;
    }
    default:
      return error.status >= 500 ? 'The server failed. Try again in a moment.' : error.message;
  }
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
