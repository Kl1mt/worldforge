import type { ModerationAction } from './roles.js';

/**
 * Sanctions (ticket 4.1, docs/SOCIAL.md "Sanctions"). Each has a reason, an expiry and an audit
 * row, and the affected player can see it.
 * - `mute`: no social writes (except reporting and the forced rename).
 * - `suspend`: no login and no use of an existing session.
 * - `rename`: the display name is replaced by a placeholder; the player chooses a new one.
 * - `hide`: one piece of content (a report target that is `hideable`) is hidden from others.
 */
export const SANCTION_KINDS = ['mute', 'suspend', 'rename', 'hide'] as const;
export type SanctionKind = (typeof SANCTION_KINDS)[number];

export type SanctionAction = 'mute' | 'suspend' | 'forceRename' | 'hideContent';

export const SANCTION_FOR_ACTION: Record<SanctionAction, SanctionKind> = {
  mute: 'mute',
  suspend: 'suspend',
  forceRename: 'rename',
  hideContent: 'hide',
};

export const ACTION_FOR_SANCTION: Record<SanctionKind, SanctionAction> = {
  mute: 'mute',
  suspend: 'suspend',
  rename: 'forceRename',
  hide: 'hideContent',
};

export function isSanctionAction(action: ModerationAction | string): action is SanctionAction {
  return action in SANCTION_FOR_ACTION;
}

const HOUR = 1;
const DAY = 24 * HOUR;

/** Allowed durations in hours, and the preset shown first. */
export const SANCTION_DURATIONS: Record<
  SanctionKind,
  { min: number; max: number; presets: number[] }
> = {
  mute: { min: HOUR, max: 365 * DAY, presets: [HOUR, DAY, 7 * DAY, 30 * DAY] },
  suspend: { min: HOUR, max: 365 * DAY, presets: [DAY, 7 * DAY, 30 * DAY, 365 * DAY] },
  // How long the player has to choose a new name; the placeholder stays until they do.
  rename: { min: DAY, max: 30 * DAY, presets: [7 * DAY, 30 * DAY] },
  hide: { min: HOUR, max: 365 * DAY, presets: [7 * DAY, 30 * DAY, 365 * DAY] },
};

export function validSanctionDuration(kind: SanctionKind, hours: number): boolean {
  const d = SANCTION_DURATIONS[kind];
  return Number.isInteger(hours) && hours >= d.min && hours <= d.max;
}

/**
 * Social writes. Every route that stores player text or reaches another player names one of these
 * and goes through the server's `socialWrite` helper. Later tickets add theirs (profile, friend,
 * guild, chat).
 */
export const SOCIAL_WRITE_ACTIONS = [
  'report',
  'rename',
  // Ticket 4.3: friends and blocks.
  'friendRequest',
  'friendAccept',
  'friendDecline',
  'friendCancel',
  'friendRemove',
  'block',
  'unblock',
  // Ticket 4.2: profile settings.
  'profile',
  // Ticket 4.4: guilds.
  'guildCreate',
  'guildInvite',
  'guildInviteCancel',
  'guildAcceptInvite',
  'guildDeclineInvite',
  'guildApply',
  'guildCancelApplication',
  'guildAcceptApplication',
  'guildDeclineApplication',
  'guildKick',
  'guildPromote',
  'guildDemote',
  'guildTransfer',
  'guildEmblem',
  'guildRename',
  'guildLeave',
  'guildDisband',
] as const;
export type SocialWriteAction = (typeof SOCIAL_WRITE_ACTIONS)[number] | (string & {});

/**
 * Social writes a mute does not block: a muted player can still report and do a forced rename,
 * and can always step away from others (ticket 4.3: decline, cancel, unfriend, block, unblock).
 * Sending or accepting a friend request reaches another player, so a mute blocks those.
 */
export const MUTE_EXEMPT: readonly string[] = [
  'report',
  'rename',
  'friendDecline',
  'friendCancel',
  'friendRemove',
  'block',
  'unblock',
  // Ticket 4.2: profile settings carry no player text, and a muted player must still be able to
  // hide their profile.
  'profile',
  // Ticket 4.4: stepping away from a guild, or withdrawing an offer, is always allowed; so is the
  // rename a moderator forced on the guild (the text filter still applies).
  'guildInviteCancel',
  'guildDeclineInvite',
  'guildCancelApplication',
  'guildDeclineApplication',
  'guildLeave',
  'guildDisband',
  'guildRename',
];

/** The sanction that blocks this social write, if any (suspension first). */
export function blockingSanction<T extends { kind: SanctionKind }>(
  active: readonly T[],
  action: SocialWriteAction,
): T | null {
  return (
    active.find((s) => s.kind === 'suspend') ??
    (MUTE_EXEMPT.includes(action) ? undefined : active.find((s) => s.kind === 'mute')) ??
    null
  );
}

export const SANCTION_LABELS: Record<SanctionKind, string> = {
  mute: 'Muted',
  suspend: 'Suspended',
  rename: 'Rename required',
  hide: 'Content hidden',
};
