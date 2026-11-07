import { useState, type ReactNode } from 'react';
import { SEASON_TITLES, findPrestigeTier, prestigeTitle, seasonName } from '@worldforge/game-core';
import { prestigeSprite } from '../content/assets';
import type { PrestigeBadge } from './seasons';
import './prestige.css';

/**
 * Ticket 5.3: prestige marks, cosmetic only. A title badge (the board's badge art by its fixed
 * name, A.10) with the title's words, and a profile frame by tier. Until the art exists, or if it
 * fails to load, the badge is a small enamelled lozenge and the frame a CSS rim in the tier's
 * metal: champion gilt, exalted brass, renowned pewter, veteran iron.
 */

function useArt(name: string) {
  const sprite = prestigeSprite(name);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = sprite !== null && failed !== sprite.path ? sprite : null;
  return { sprite: shown, onError: () => sprite && setFailed(sprite.path) };
}

/** The title a player shows: badge and words ("Exalted Pathfinder"), with the season. */
export function TitleBadge({
  badge,
  compact = false,
}: {
  badge: PrestigeBadge | null;
  /** Rows (boards, rosters): the season as a short mark. */
  compact?: boolean;
}) {
  const art = useArt(badge ? SEASON_TITLES[badge.metric].badgeAsset : '');
  if (!badge) return null;
  const title = prestigeTitle(badge.metric, badge.tier);
  const season = seasonName(badge.season);
  return (
    <span
      className={`honour honour--${badge.tier}${compact ? ' honour--compact' : ''}`}
      title={`${title}, ${season}`}
    >
      {art.sprite ? (
        <img
          className="honour__badge pixel"
          src={art.sprite.path}
          alt=""
          width={art.sprite.width}
          height={art.sprite.height}
          draggable={false}
          onError={art.onError}
        />
      ) : (
        <span className="honour__lozenge" aria-hidden="true" />
      )}
      <span className="honour__words">{title}</span>
      <span className="honour__season">{compact ? `S${badge.season}` : season}</span>
    </span>
  );
}

/** A rim around a name or a portrait, by the tier of the chosen frame (none: no rim). */
export function PrestigeFrame({
  frame,
  children,
  size = 'md',
}: {
  frame: PrestigeBadge | null;
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  const tier = frame ? findPrestigeTier(frame.tier) : undefined;
  const art = useArt(tier?.frameAsset ?? '');
  if (!frame || !tier) return <>{children}</>;
  return (
    <span
      className={`honourframe honourframe--${tier.id} honourframe--${size}${art.sprite ? ' honourframe--art' : ''}`}
      title={`${tier.name} frame, ${seasonName(frame.season)}`}
    >
      {art.sprite ? (
        <img
          className="honourframe__art pixel"
          src={art.sprite.path}
          alt=""
          draggable={false}
          onError={art.onError}
        />
      ) : null}
      <span className="honourframe__inner">{children}</span>
    </span>
  );
}

/** A small frame mark for a row: the tier's rim around its initial. */
export function FrameMark({ frame }: { frame: PrestigeBadge | null }) {
  const tier = frame ? findPrestigeTier(frame.tier) : undefined;
  if (!frame || !tier) return null;
  return (
    <PrestigeFrame frame={frame} size="sm">
      <span className="honourframe__glyph" aria-label={`${tier.name} frame`}>
        {tier.name[0]}
      </span>
    </PrestigeFrame>
  );
}
