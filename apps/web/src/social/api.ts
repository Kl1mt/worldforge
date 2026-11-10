import type {
  AccountRole,
  BannerId,
  ClassId,
  EquipmentSlotId,
  GuildRole,
  ProfileVisibility,
  RarityId,
  RolledAffix,
  ReportReasonId,
  ReportTarget,
  SanctionAction,
  SanctionKind,
} from '@worldforge/game-core';
import type { PrestigeShown } from './seasons';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** A sanction as its subject sees it (server `SanctionView`, ticket 4.1). */
export interface Sanction {
  id: string;
  kind: SanctionKind;
  reason: string;
  createdAt: string;
  expiresAt: string;
  target: ReportTarget | null;
}

export interface Standing {
  handle: string;
  role: AccountRole;
  sanctions: Sanction[];
  renameRequired: boolean;
}

export interface PlayerRef {
  handle: string;
  displayName: string;
}

/** A hero on a profile (ticket 4.2); `name` is null while a moderator hides it. */
export interface ProfileHero {
  name: string | null;
  classId: ClassId;
  level: number;
  appearance: { banner: BannerId };
}

/** An equipped item as other players see it: no ids, seeds or dates. */
export interface ShowcaseItem {
  slot: EquipmentSlotId;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: RolledAffix[];
  upgradeLevel: number;
  variant: string | null;
  effectId: string | null;
  effectRoll: number | null;
  setId: string | null;
  mythicId: string | null;
  /** Ticket 6.5b: present only on an awakened item. */
  awakening?: { option: 'effect'; effectStrength: number };
}

export interface Profile {
  handle: string;
  displayName: string | null;
  self: boolean;
  visibility: ProfileVisibility | null;
  characters: ProfileHero[];
  achievements: { id: string; awardedOn: string }[];
  showcase: (ProfileHero & { equipped: ShowcaseItem[] }) | null;
  /** Ticket 4.4: the owner's guild (null when none, or hidden from you). */
  guild: { handle: string; name: string; tag: string; emblem: string; role: GuildRole } | null;
  /** Ticket 5.3: the season title and frame the owner shows. */
  prestige: PrestigeShown;
}

export interface ProfileSettings {
  visibility: ProfileVisibility;
  showcaseCharacterId: string | null;
  shown: string[];
  earned: { id: string; awardedAt: string; characterName: string | null }[];
  characters: { id: string; name: string }[];
}

export interface FiledReport {
  id: string;
  target: ReportTarget;
  reason: ReportReasonId;
  note: string | null;
  status: string;
  createdAt: string;
}

export interface ModCase {
  reportId: string;
  target: ReportTarget;
  subject: {
    handle: string;
    displayName: string;
    role: AccountRole;
    sanctions: Sanction[];
    pastSanctions: number;
  };
  current: { value: string; hidden: boolean };
  reports: {
    id: string;
    reason: ReportReasonId;
    note: string | null;
    createdAt: string;
    context: Record<string, unknown>;
    reporter: PlayerRef;
  }[];
  openedAt: string;
}

export interface ModQueue {
  cases: ModCase[];
  openCases: number;
  nextCursor: string | null;
}

export type ResolveBody =
  | { action: 'dismiss'; note?: string }
  | { action: SanctionAction; reason: string; durationHours: number }
  /** Ticket 4.4: on a reported guild. */
  | { action: 'renameGuild' | 'disbandGuild'; reason: string };

export const socialApi = {
  standing: (signal?: AbortSignal): Promise<ApiResult<Standing>> =>
    apiRequest('/account/standing', signal ? { signal } : {}),
  rename: (displayName: string): Promise<ApiResult<{ displayName: string }>> =>
    apiRequest('/account/display-name', { method: 'POST', body: { displayName } }),
  lookup: (name: string): Promise<ApiResult<{ player: PlayerRef }>> =>
    apiRequest(`/players/lookup?name=${encodeURIComponent(name)}`),
  profile: (handle: string, signal?: AbortSignal): Promise<ApiResult<{ profile: Profile }>> =>
    apiRequest(`/players/${encodeURIComponent(handle)}/profile`, signal ? { signal } : {}),
  profileSettings: (signal?: AbortSignal): Promise<ApiResult<ProfileSettings>> =>
    apiRequest('/account/profile', signal ? { signal } : {}),
  saveProfile: (body: {
    visibility: ProfileVisibility;
    shown: string[];
    showcaseCharacterId: string | null;
  }): Promise<ApiResult<ProfileSettings>> =>
    apiRequest('/account/profile', { method: 'POST', body }),
  report: (body: {
    target: ReportTarget;
    reason: ReportReasonId;
    note?: string;
  }): Promise<ApiResult<{ report: FiledReport }>> =>
    apiRequest('/reports', { method: 'POST', body }),
  queue: (signal?: AbortSignal): Promise<ApiResult<ModQueue>> =>
    apiRequest('/mod/queue?limit=50', signal ? { signal } : {}),
  resolve: (
    reportId: string,
    body: ResolveBody,
  ): Promise<ApiResult<{ closedReports: number; sanction: Sanction | null }>> =>
    apiRequest(`/mod/reports/${reportId}/resolve`, { method: 'POST', body }),
  lift: (sanctionId: string, reason: string): Promise<ApiResult<{ sanction: Sanction }>> =>
    apiRequest(`/mod/sanctions/${sanctionId}/lift`, { method: 'POST', body: { reason } }),
};

/** The sanction carried by a `403 account_suspended` / `403 muted` failure, if any. */
export function sanctionOf(error: Pick<ApiFailure, 'details'> | unknown): Sanction | null {
  const details = (error as { details?: unknown })?.details ?? error;
  const s = (details as { sanction?: unknown } | null)?.sanction;
  return s && typeof s === 'object' && 'kind' in s ? (s as Sanction) : null;
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** "6 November 2026, 14:00 UTC" — sanction expiries are exact on purpose (the player's own). */
export function formatWhen(iso: string): string {
  return DATE.format(new Date(iso));
}

/** One sentence the sanctioned player reads: what it means and until when. */
export function describeSanction(s: Sanction): string {
  const until = formatWhen(s.expiresAt);
  switch (s.kind) {
    case 'mute':
      return `You are muted until ${until}: you cannot post or reach other players, but you can still play and report.`;
    case 'suspend':
      return `Your account is suspended until ${until}.`;
    case 'rename':
      return `Your display name was changed by a moderator. Choose a new one before ${until}.`;
    case 'hide':
      if (s.target?.kind === 'characterName') {
        return `Your hero name “${s.target.name}” is hidden from other players until ${until}.`;
      }
      if (s.target?.kind === 'message') {
        return `One of your guild chat lines is hidden by the wardens until ${until}.`;
      }
      return `Your display name is hidden from other players until ${until}.`;
    case 'trade':
      return `Your trading is restricted until ${until}: you can’t send or accept trade offers. Play, chat and the account shelf work as usual.`;
  }
}

/** Plain words for a social failure (report dialog, rename, moderator actions). */
export function describeSocialFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'report_open':
      return 'You already reported this. A moderator will look at it.';
    case 'cannot_report_self':
      return 'You cannot report yourself.';
    case 'not_found':
      return 'No player goes by that name.';
    case 'achievement_not_earned':
      return 'Show only achievements you have earned.';
    case 'not_your_character':
      return 'Showcase one of your own heroes.';
    case 'rate_limited': {
      const s = error.retryAfterSeconds ?? 60;
      return `Too many reports and posts in a short time. Try again in ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`}.`;
    }
    case 'muted':
    case 'account_suspended': {
      const s = sanctionOf(error);
      return s ? describeSanction(s) : error.message;
    }
    case 'report_closed':
      return 'Another moderator already handled this case.';
    case 'already_sanctioned':
      return 'This player already has an active sanction of that kind. Lift it first.';
    case 'forbidden':
      return error.message;
    case 'not_hideable':
      return 'Only content can be hidden, not a whole player. Report the name instead.';
    case 'sanction_inactive':
      return 'That sanction has already ended.';
    // Ticket 4.4: guild cases.
    case 'guild_gone':
      return 'This guild was disbanded already.';
    case 'not_a_guild':
    case 'use_rename_guild':
      return error.message;
    case 'validation_failed':
      return Object.values(error.fields)[0] ?? 'Some fields need attention.';
    case 'network':
      return 'The server cannot be reached. Check your connection and try again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}
