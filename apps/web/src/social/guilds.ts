import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuildRole, PresenceBucket } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { Character } from '../characters/api';
import { describeSanction, describeSocialFailure, sanctionOf } from './api';

/** Ticket 4.4: a guild as anyone sees it. */
export interface GuildSummary {
  handle: string;
  name: string;
  tag: string;
  emblem: string;
  memberCount: number;
  /** UTC day, `YYYY-MM-DD`. */
  foundedOn: string;
}

export interface GuildPerson {
  handle: string;
  /** Null while a moderator hides the name. */
  displayName: string | null;
}

export interface GuildMemberEntry extends GuildPerson {
  role: GuildRole;
  /** A bucket, never a time; null when hidden (or when they block you). */
  presence: PresenceBucket | null;
  joinedOn: string;
  /** You block this member: the name is withheld, the row stays so officers can act. */
  blocked: boolean;
}

export interface MyGuild extends GuildSummary {
  role: GuildRole;
  renameRequired: boolean;
  renameReason: string | null;
  members: GuildMemberEntry[];
  /** Officers and the leader only (empty for members). */
  invites: { player: GuildPerson; invitedOn: string }[];
  applications: { player: GuildPerson; appliedOn: string }[];
}

export interface GuildNotice {
  kind: 'kicked' | 'disbanded' | 'disbandedByModerator';
  guildName: string;
  on: string;
  reason: string | null;
}

export interface GuildHallView {
  guild: MyGuild | null;
  invites: { guild: GuildSummary; invitedBy: GuildPerson | null; invitedOn: string }[];
  applications: { guild: GuildSummary; appliedOn: string }[];
  notice: GuildNotice | null;
  createCost: number;
  limits: {
    members: number;
    invitesPerGuild: number;
    invitesPerAccount: number;
    applicationsPerGuild: number;
    applicationsPerAccount: number;
  };
}

export type GuildStandingView = 'member' | 'invited' | 'applied' | 'otherGuild' | 'none';

export interface GuildProfile {
  guild: GuildSummary;
  members: (GuildPerson & { role: GuildRole })[];
  standing: GuildStandingView;
}

type Ok = Promise<ApiResult<{ ok: boolean }>>;
const post = (path: string, body?: object): Ok =>
  apiRequest(path, { method: 'POST', ...(body ? { body } : {}) });
const h = encodeURIComponent;

export const guildApi = {
  hall: (signal?: AbortSignal): Promise<ApiResult<GuildHallView>> =>
    apiRequest('/guild', signal ? { signal } : {}),
  search: (q: string, signal?: AbortSignal): Promise<ApiResult<{ guilds: GuildSummary[] }>> =>
    apiRequest(`/guilds${q ? `?q=${h(q)}` : ''}`, signal ? { signal } : {}),
  profile: (handle: string, signal?: AbortSignal): Promise<ApiResult<GuildProfile>> =>
    apiRequest(`/guilds/${h(handle)}`, signal ? { signal } : {}),
  /** A value operation: keep `key` for retries of the same founding. */
  found: (
    input: { characterId: string; name: string; tag: string; emblem: string },
    key: string,
  ): Promise<ApiResult<{ guild: GuildSummary; character: Character }>> =>
    apiRequest('/guilds', { method: 'POST', body: input, headers: { 'idempotency-key': key } }),
  apply: (handle: string) => post(`/guilds/${h(handle)}/apply`),
  withdraw: (handle: string) => post(`/guilds/${h(handle)}/application/cancel`),
  acceptInvite: (handle: string) => post(`/guilds/${h(handle)}/invite/accept`),
  declineInvite: (handle: string) => post(`/guilds/${h(handle)}/invite/decline`),
  inviteByName: (name: string) => post('/guild/invites', { name }),
  cancelInvite: (handle: string) => post(`/guild/invites/${h(handle)}/cancel`),
  acceptApplication: (handle: string) => post(`/guild/applications/${h(handle)}/accept`),
  declineApplication: (handle: string) => post(`/guild/applications/${h(handle)}/decline`),
  kick: (handle: string) => post(`/guild/members/${h(handle)}/kick`),
  promote: (handle: string) => post(`/guild/members/${h(handle)}/promote`),
  demote: (handle: string) => post(`/guild/members/${h(handle)}/demote`),
  transfer: (handle: string) => post(`/guild/members/${h(handle)}/transfer`),
  leave: () => post('/guild/leave'),
  disband: (name: string) => post('/guild/disband', { name }),
  emblem: (emblem: string) => post('/guild/emblem', { emblem }),
  rename: (name: string, tag: string) => post('/guild/rename', { name, tag }),
};

/** Plain words for a guild failure. */
export function describeGuildFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'not_found':
      return 'No such guild or player.';
    case 'insufficient_gold':
      return 'That hero’s purse is too light to found a guild.';
    case 'guild_name_taken':
    case 'guild_tag_taken':
    case 'already_in_guild':
    case 'guild_forbidden':
    case 'leader_must_hand_over':
    case 'guild_full':
    case 'invite_limit':
    case 'invite_inbox_full':
    case 'application_limit':
    case 'application_limit_guild':
    case 'invite_pending':
    case 'application_pending':
    case 'target_in_guild':
    case 'blocked_by_you':
    case 'no_invite':
    case 'no_application':
    case 'not_a_member':
    case 'already_officer':
    case 'not_an_officer':
    case 'cannot_target_self':
    case 'confirm_mismatch':
    case 'name_not_allowed':
    case 'rename_not_required':
    case 'not_in_guild':
      return error.message;
    case 'muted': {
      const s = sanctionOf(error);
      return s ? describeSanction(s) : error.message;
    }
    case 'rate_limited': {
      const s = error.retryAfterSeconds ?? 60;
      return `Too many social actions in a short time. Try again in ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`}.`;
    }
    default:
      return describeSocialFailure(error);
  }
}

export type GuildHallState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: GuildHallView; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/**
 * The guild page, polled while mounted (every 60 s; the server's ETag makes an unchanged page a
 * `304`, ≤ 1 request a minute per tab). A failed poll keeps the last page and marks it stale.
 */
export function useGuildHall(pollMs = 60_000) {
  const [state, setState] = useState<GuildHallState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const last = useRef<GuildHallView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      guildApi.hall(controller.signal).then(
        (res) => {
          if (res.ok) {
            last.current = res.value;
            setState({ kind: 'ready', view: res.value, stale: false });
          } else if (last.current) {
            setState({ kind: 'ready', view: last.current, stale: true });
          } else {
            setState({ kind: 'error', error: res.error });
          }
          if (pollMs > 0) timer = setTimeout(load, pollMs);
        },
        () => {
          /* aborted */
        },
      );
    };
    load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt, pollMs]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
