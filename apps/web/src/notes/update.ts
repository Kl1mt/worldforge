import { GAME_VERSION, isNewerVersion } from '@worldforge/game-core';
import type { Notice } from '../onboarding/notices';
import type { SeenStore } from '../onboarding/seen';

/**
 * Ticket F.4: the reload hint. A tab kept open through a deploy still runs the old build; when
 * the server answers with a newer version (or a part of the old build fails to load), a quiet
 * herald slip offers a reload. It never reloads by itself.
 *
 * "Later" is kept per browser in localStorage, for that version only: the next version asks
 * again. A convenience, not game state (no migration), like the "seen" lists.
 */
export const RELOAD_LATER_KEY = 'wf.reload.later';

export function readReloadLater(store: SeenStore): string | null {
  return store.get(RELOAD_LATER_KEY);
}

export function writeReloadLater(store: SeenStore, version: string): void {
  store.set(RELOAD_LATER_KEY, version);
}

export interface ReloadOfferInput {
  /** The server's version from the health poll (null until one arrived). */
  serverVersion: string | null;
  /** The version this tab's build was made at. */
  bundled?: string;
  /** The version the player chose "Later" for (null: none). */
  later: string | null;
  /** The first-steps guide is still running: the hint waits for it. */
  guideActive: boolean;
  /** A part of this build failed to load (the old files are gone after a deploy). */
  chunkFailed: boolean;
}

export type ReloadOffer =
  | { show: false }
  /** `version`: the newer version, when the server told us one. */
  | { show: true; version: string | null; reason: 'newer' | 'chunk' };

/**
 * Whether to offer a reload. A newer server version (strictly newer; an equal, older or
 * malformed answer never prompts) shows unless the player said "Later" to that very version or
 * the guide still runs. A failed load always shows: the screen cannot work without a reload.
 */
export function reloadOffer(input: ReloadOfferInput): ReloadOffer {
  const bundled = input.bundled ?? GAME_VERSION;
  const newer = isNewerVersion(input.serverVersion, bundled) ? input.serverVersion : null;
  if (input.chunkFailed) return { show: true, version: newer, reason: 'chunk' };
  if (!newer || input.later === newer || input.guideActive) return { show: false };
  return { show: true, version: newer, reason: 'newer' };
}

const RELOAD_PREFIX = 'reload:';

export function isReloadNoticeId(id: string): boolean {
  return id.startsWith(RELOAD_PREFIX);
}

/** The herald slip for a reload offer. Rendered with Reload and Later (`Notices.tsx`). */
export function reloadNotice(offer: { version: string | null; reason: 'newer' | 'chunk' }): Notice {
  const id = `${RELOAD_PREFIX}${offer.version ?? 'unknown'}`;
  if (offer.reason === 'chunk') {
    return {
      id,
      kind: 'reload',
      title: 'Graumark has changed',
      text: offer.version
        ? `Part of the town did not load: v${offer.version} is out. Reload to join it.`
        : 'Part of the town did not load: a newer version is out. Reload to join it.',
    };
  }
  return {
    id,
    kind: 'reload',
    title: 'Graumark has changed',
    text: `v${offer.version} is out. Reload to join it.`,
  };
}
