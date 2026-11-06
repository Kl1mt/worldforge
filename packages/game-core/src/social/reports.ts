/**
 * Report targets and reasons (ticket 4.1, docs/SOCIAL.md "Reports").
 *
 * `ReportTarget` is a discriminated union that later tickets extend: 4.1 has `player` and
 * `profileField` (the display name, the only player-written field so far); profiles (4.2) add
 * profile fields, guilds add `{ kind: 'guild', guildId }`, chat adds `{ kind: 'message', messageId }`.
 * Each new kind adds itself here and registers a resolver on the server
 * (`apps/server/src/social/targets.ts`). Targets name players by their public handle, never by
 * account id.
 */
export const PROFILE_FIELD_IDS = ['displayName'] as const;
export type ProfileFieldId = (typeof PROFILE_FIELD_IDS)[number];

export type ReportTarget =
  | { kind: 'player'; handle: string }
  | { kind: 'profileField'; handle: string; field: ProfileFieldId };

export type ReportTargetKind = ReportTarget['kind'];

export interface ReportTargetKindInfo {
  /** Moderators may hide it (`hideContent`): it is content, not a person. */
  hideable: boolean;
  label: string;
}

export const REPORT_TARGET_KINDS: Record<ReportTargetKind, ReportTargetKindInfo> = {
  player: { hideable: false, label: 'Player' },
  profileField: { hideable: true, label: 'Profile field' },
};

export const REPORT_TARGET_KIND_IDS = Object.keys(REPORT_TARGET_KINDS) as ReportTargetKind[];

export const PROFILE_FIELD_LABELS: Record<ProfileFieldId, string> = {
  displayName: 'Display name',
};

export const REPORT_REASONS = [
  { id: 'spam', label: 'Spam or advertising' },
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'hate', label: 'Hate speech' },
  { id: 'inappropriate', label: 'Inappropriate name or content' },
  { id: 'impersonation', label: 'Pretends to be staff or someone else' },
  { id: 'cheating', label: 'Cheating or exploiting' },
  { id: 'other', label: 'Something else' },
] as const;

export type ReportReasonId = (typeof REPORT_REASONS)[number]['id'];
export const REPORT_REASON_IDS = REPORT_REASONS.map((r) => r.id) as ReportReasonId[];

/**
 * Public handles: opaque, random, permanent, and not derived from the account id or anything
 * else (docs/SOCIAL.md "Handles"). 12 characters from a 32-letter alphabet without look-alikes.
 */
export const HANDLE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const HANDLE_LENGTH = 12;
export const HANDLE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;

export function isHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_RE.test(value);
}

/** Builds a handle from 12 or more random bytes (the caller supplies them: no RNG here). */
export function handleFromBytes(bytes: ArrayLike<number>): string {
  if (bytes.length < HANDLE_LENGTH) throw new Error('need at least 12 random bytes');
  let s = '';
  for (let i = 0; i < HANDLE_LENGTH; i++) s += HANDLE_ALPHABET[bytes[i]! & 31];
  return s;
}
