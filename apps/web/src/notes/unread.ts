import { GAME_VERSION, compareVersions } from '@worldforge/game-core';
import type { Notice } from '../onboarding/notices';

/**
 * Ticket F.3: the "What's new" unread marker. The version a player last read the notes at is kept
 * per account in this browser's localStorage (a convenience, not game state; no migration), like
 * the other "seen" lists (`onboarding/seen.ts`).
 */
export function notesSeenKey(accountId: string): string {
  return `wf.seen.notes.${accountId}`;
}

export interface NotesUnread {
  /** The status bar's version link carries a "New" tag. */
  unread: boolean;
  /** Show the herald slip ("New in v…"). Never while the first-steps guide is still running. */
  announce: boolean;
  /** Store the current version without telling: a brand-new player needs no history lesson. */
  baseline: boolean;
}

/**
 * What to show for a stored last-seen version (`null` when this browser never stored one).
 * A player still on the first-steps guide gets no slip, so the two never compete; a new player
 * (guide running, nothing stored) starts from the current version.
 */
export function notesUnread(
  lastSeen: string | null,
  guideActive: boolean,
  current: string = GAME_VERSION,
): NotesUnread {
  if (lastSeen === null && guideActive) return { unread: false, announce: false, baseline: true };
  const unread = lastSeen === null || compareVersions(lastSeen, current) < 0;
  return { unread, announce: unread && !guideActive, baseline: false };
}

/**
 * Whether a release counts as new on the notes screen: newer than what the player had read
 * before opening it. With nothing read before, only the current release is new.
 */
export function isNewRelease(
  version: string,
  seenBefore: string | null,
  current: string = GAME_VERSION,
): boolean {
  if (seenBefore === null) return version === current;
  return compareVersions(version, seenBefore) > 0;
}

export function releaseNoticeId(version: string = GAME_VERSION): string {
  return `release:${version}`;
}

/** The herald slip for a new release. Least important of all notices (`orderNotices`). */
export function releaseNotice(version: string = GAME_VERSION): Notice {
  return {
    id: releaseNoticeId(version),
    kind: 'release',
    title: `New in v${version}`,
    text: 'The town crier has news of what changed in Graumark.',
    href: '#/notes',
    linkLabel: 'Read the notes',
  };
}

/** `0.5.2` → `v0.5.2`. */
export function versionLabel(version: string = GAME_VERSION): string {
  return `v${version}`;
}
