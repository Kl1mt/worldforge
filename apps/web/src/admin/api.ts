import type {
  AccountRole,
  ClassId,
  ReportTarget,
  SanctionKind,
  TradingSettings,
  TradingSettingsChange,
} from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { SeasonList } from '../social/seasons';
import type { EventView } from '../events/api';

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
  // Ticket T.2: trading settings. Staff read (moderators read-only), admins save.
  tradingSettings: (signal?: AbortSignal, cursor?: string) =>
    get<TradingSettingsView>(
      `/mod/settings/trading${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal,
    ),
  saveTradingSettings: (expectedVersion: number, settings: TradingSettings, key: string) =>
    apiRequest<TradingSettingsView & { changed: boolean }>('/admin/settings/trading', {
      method: 'PUT',
      body: { expectedVersion, settings },
      headers: { 'Idempotency-Key': key },
    }),
  /** Ticket 6.6: the event calendar. */
  events: (signal?: AbortSignal) => get<AdminEvents>('/admin/events', signal),
  scheduleEvent: (input: { definitionId: string; startsAt: string; endsAt: string }) =>
    apiRequest<AdminEvents>('/admin/events', { method: 'POST', body: input }),
  /** `endsAt` omitted: end the event now. */
  endEvent: (number: number, endsAt?: string) =>
    apiRequest<AdminEvents>(`/admin/events/${number}/end`, {
      method: 'POST',
      body: endsAt ? { endsAt } : {},
    }),
  cancelEvent: (number: number) =>
    apiRequest<AdminEvents>(`/admin/events/${number}/cancel`, { method: 'POST' }),
  /** Ticket 8.3: the automatic calendar (pause, resume, rotation, gap) and skip. */
  setEventCalendar: (patch: {
    paused?: boolean;
    rotation?: CalendarEntryInput[];
    gapDays?: number;
  }) => apiRequest<AdminEvents>('/admin/events/calendar', { method: 'POST', body: patch }),
  skipCalendarEvent: () =>
    apiRequest<AdminEvents>('/admin/events/calendar/skip', { method: 'POST' }),
  /** Ticket 6.9: the reserved-names store (built in and added by admins). */
  reservedNames: (signal?: AbortSignal) =>
    get<{ names: ReservedNameRow[] }>('/admin/reserved-names', signal),
  addReservedName: (input: { name: string; note: string; reason: string }, key: string) =>
    apiRequest<{ names: ReservedNameRow[] }>('/admin/reserved-names', {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': key },
    }),
  removeReservedName: (id: string, reason: string, key: string) =>
    apiRequest<{ names: ReservedNameRow[] }>(`/admin/reserved-names/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: { reason },
      headers: { 'Idempotency-Key': key },
    }),
  /** Ticket 8.6: the going-live readiness board (read-only). */
  readiness: (signal?: AbortSignal) => get<ReadinessReport>('/admin/readiness', signal),
  savePrivacyTicks: (expectedVersion: number, ticked: string[], key: string) =>
    apiRequest<ReadinessReport>('/admin/readiness/privacy', {
      method: 'PUT',
      body: { expectedVersion, ticked },
      headers: { 'Idempotency-Key': key },
    }),
  /** The address is sent once and never stored; the answer never repeats it. */
  sendTestLetter: (to: string) =>
    apiRequest<{ outcome: 'sent' | 'failed'; code: string | null; at: string }>(
      '/admin/readiness/test-letter',
      { method: 'POST', body: { to } },
    ),
  /** `endsAt` omitted: end the season now. */
  endSeason: (number: number, endsAt?: string) =>
    apiRequest<AdminSeasons>(`/admin/seasons/${number}/end`, {
      method: 'POST',
      body: endsAt ? { endsAt } : {},
    }),
};

/** Ticket 8.6: the readiness board (`GET /api/admin/readiness`). */
export type ReadinessStatus = 'done' | 'attention' | 'not_set';
export type ReadinessLink =
  | { kind: 'tab'; section: string; label: string }
  | { kind: 'doc'; path: string; anchor: string; label: string };
export interface ReadinessItem {
  id: string;
  title: string;
  status: ReadinessStatus;
  summary: string;
  facts: { label: string; value: string }[];
  links: ReadinessLink[];
}
export interface ReadinessReport {
  items: ReadinessItem[];
  privacy: {
    checklist: { id: string; label: string; hint: string; ticked: boolean }[];
    version: number;
    updatedAt: string | null;
  };
  testLetter: { available: boolean };
  generatedAt: string;
}

/** Where a readiness doc link points: the file in the public repository, at its heading. */
export const DOCS_BASE = 'https://github.com/Kl1mt/worldforge/blob/main/';
export function docHref(path: string, anchor: string): string {
  return `${DOCS_BASE}${path}${anchor ? `#${anchor}` : ''}`;
}

/** Ticket 6.9: one reserved name; built-in ones (`id: null`) can't be removed. */
export interface ReservedNameRow {
  id: string | null;
  name: string;
  group: 'staff' | 'boss' | 'npc' | 'custom';
  note: string;
  createdAt: string | null;
}

/** Ticket T.2: `GET /api/mod/settings/trading`. */
export interface TradingSettingsView {
  settings: TradingSettings;
  defaults: TradingSettings;
  /** 0 while nothing was ever saved (the launch defaults). */
  version: number;
  updatedAt: string | null;
  updatedBy: PlayerRef | null;
  /** False for moderators (read-only). */
  canEdit: boolean;
  history: {
    id: string;
    at: string;
    by: PlayerRef | null;
    version: number;
    changes: TradingSettingsChange[];
  }[];
  nextCursor: string | null;
}

/** Ticket 5.3: the admin panel's season view (`GET /api/admin/seasons`). */
export interface AdminSeasons extends SeasonList {
  counts: { season: number; entries: number; standings: number; awards: number }[];
}

/** Ticket 6.6: the admin panel's event view (`GET /api/admin/events`). */
export interface AdminEvents {
  now: string;
  /** `minDays` (8.3b): the fewest days it may last (its weeks × 7; 0: no minimum). */
  definitions: {
    id: string;
    name: string;
    tagline: string;
    defaultDays: number;
    minDays: number;
  }[];
  current: EventView | null;
  next: EventView | null;
  past: {
    event: EventView;
    closedAt: string | null;
    cancelledAt: string | null;
    rewardsSweptAt: string | null;
  }[];
  counts: { event: number; heroes: number; accounts: number; questsDone: number; grants: number }[];
  /** Ticket 8.3: the automatic calendar and the next three planned events. */
  calendar: {
    paused: boolean;
    /** False until the owner first saves it (the defaults). */
    saved: boolean;
    rotation: { definitionId: string; name: string; days: number }[];
    gapDays: number;
    nextIndex: number;
    createdCount: number;
    updatedAt: string | null;
    planned: {
      definitionId: string;
      name: string;
      startsAt: string;
      endsAt: string;
      kind: 'scheduled' | 'rotation';
      number: number | null;
      source: 'manual' | 'calendar' | null;
    }[];
  };
}

/** Ticket 8.3: one entry of the calendar's rotation. */
export interface CalendarEntryInput {
  definitionId: string;
  days: number;
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
    case 'settings_conflict':
      return 'Another admin saved these settings since you opened them. Reload to see their change, then make yours again.';
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
