import { useState, type ReactNode } from 'react';
import {
  SEASON_TITLES,
  findCosmetic,
  findPrestigeTier,
  prestigeTitle,
  seasonName,
} from '@worldforge/game-core';
import { SEASON_FRAME_WINDOW, prestigeSprite } from '../content/assets';
import type { PrestigeBadge, PrestigeShown } from './seasons';
import { titleColourClass } from '../cosmetics/Cosmetics';
import './prestige.css';

/**
 * Ticket 5.3: prestige marks, cosmetic only, drawn with A.10's art by its fixed names:
 * - `TitleBadge`: the board's 32×32 badge with the title's words (×1, or shrunk smoothly to 24 px
 *   in rows, the one exception to integer scaling; always beside its text);
 * - `FramedPlate`: the tier's 64×64 frame at an integer scale over content that fills its window
 *   (×1 around a 32 px badge, ×4 around a 128 px class portrait);
 * - `FrameMark`: in rows, where a 64 px frame does not fit, a small rim in the tier's metal.
 * If the art is missing or fails to load: an enamelled lozenge and a CSS rim per tier.
 */

function useArt(name: string) {
  const sprite = name ? prestigeSprite(name) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const shown = sprite !== null && failed !== sprite.path ? sprite : null;
  return { sprite: shown, onError: () => sprite && setFailed(sprite.path) };
}

/** The title a player shows: badge and words ("Exalted Pathfinder"), with the season. */
export function TitleBadge({
  badge,
  compact = false,
  colour = null,
}: {
  badge: PrestigeBadge | null;
  /** Rows (boards, rosters): a 24 px badge and the season as a short mark. */
  compact?: boolean;
  /** Ticket 6.8: the account's title colour (`title-colour.<name>`), or null. */
  colour?: string | null;
}) {
  const art = useArt(badge ? SEASON_TITLES[badge.metric].badgeAsset : '');
  if (!badge) return null;
  const title = prestigeTitle(badge.metric, badge.tier);
  const season = seasonName(badge.season);
  return (
    <span
      className={`honour honour--${badge.tier}${compact ? ' honour--compact' : ''} ${titleColourClass(colour)}`.trimEnd()}
      title={`${title}, ${season}`}
    >
      {art.sprite ? (
        <img
          className={`honour__badge${compact ? ' honour__badge--small' : ' pixel'}`}
          src={art.sprite.path}
          alt=""
          width={compact ? 24 : art.sprite.width}
          height={compact ? 24 : art.sprite.height}
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

/**
 * Ticket 6.6: a cosmetic title (an event's, e.g. "Reaper of the Harvest"): the same plate as a
 * season title, in bone with a wine-dark lozenge, and where it came from instead of the season.
 */
export function CosmeticTitle({
  id,
  compact = false,
  colour = null,
}: {
  id: string;
  compact?: boolean;
  colour?: string | null;
}) {
  const c = findCosmetic(id);
  if (!c || c.kind !== 'title') return null;
  return (
    <span
      className={`honour honour--cosmetic${compact ? ' honour--compact' : ''} ${titleColourClass(colour)}`.trimEnd()}
      title={`${c.name}: ${c.description}`}
    >
      <span className="honour__lozenge" aria-hidden="true" />
      <span className="honour__words">{c.name}</span>
      {compact ? null : <span className="honour__season">Event title</span>}
    </span>
  );
}

/** The title a player shows: a cosmetic title if chosen, else the season title (or nothing). */
export function ShownTitle({
  shown,
  compact = false,
}: {
  shown: PrestigeShown | null | undefined;
  compact?: boolean;
}) {
  // Ticket 6.8: the account's title colour applies to whichever title is shown.
  const colour = shown?.titleColour ?? null;
  if (shown?.cosmeticTitle) {
    return <CosmeticTitle id={shown.cosmeticTitle} compact={compact} colour={colour} />;
  }
  return <TitleBadge badge={shown?.title ?? null} compact={compact} colour={colour} />;
}

/**
 * The tier's frame at ×`scale` (64 px × scale) over `children`, centred in the frame's window
 * (36 px × scale). Without art: the same box with a CSS rim. None chosen: nothing.
 */
export function FramedPlate({
  frame,
  scale,
  children,
}: {
  frame: PrestigeBadge | null;
  scale: 1 | 2 | 4;
  children: ReactNode;
}) {
  const tier = frame ? findPrestigeTier(frame.tier) : undefined;
  const art = useArt(tier?.frameAsset ?? '');
  if (!frame || !tier) return null;
  const size = 64 * scale;
  const w = SEASON_FRAME_WINDOW;
  return (
    <span
      className={`honourplate honour--${tier.id}${art.sprite ? '' : ' honourplate--rim'}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${tier.name} frame, ${seasonName(frame.season)}`}
    >
      <span
        className="honourplate__window"
        style={{
          left: w.x * scale,
          top: w.y * scale,
          width: w.width * scale,
          height: w.height * scale,
        }}
      >
        {children}
      </span>
      {art.sprite ? (
        <img
          className="honourplate__art pixel"
          src={art.sprite.path}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={art.onError}
        />
      ) : null}
    </span>
  );
}

/** A rim in the tier's metal around a name (CSS only). */
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
  if (!frame || !tier) return <>{children}</>;
  return (
    <span
      className={`honourframe honourframe--${tier.id} honourframe--${size}`}
      title={`${tier.name} frame, ${seasonName(frame.season)}`}
    >
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
