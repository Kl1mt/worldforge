import { useState, type ReactNode } from 'react';
import { findCosmetic, type ClassId } from '@worldforge/game-core';
import { PixelSprite } from '../components/PixelSprite';
import { classPortrait, type SpriteAsset } from '../content/assets';
import { appearancePalette, bannerStyleSprite, crestStyleSprite } from '../content/appearance';
import './cosmetics.css';

/**
 * Ticket 6.8: the collection book's cosmetics as drawn everywhere (docs/COSMETICS.md "Display").
 * Cosmetic only. Each falls back gracefully while the art (A.13) is missing or fails to load:
 * - `HeroLook`: the class portrait in the hero's appearance (palette swap in code; own colours
 *   without palette data);
 * - `BannerStyle`: the banner style's 32×32 device at an integer scale on the banner cloth; a plain
 *   cloth without art;
 * - `CrestRim` / `CrestMark`: the crest style's frame around content (profiles) or a small mark
 *   (rows); a plain rim in the style's metal without art;
 * - `titleColourClass`: the shown title's colour (CSS only, never art).
 */

const suffix = (id: string) => id.slice(id.indexOf('.') + 1);

function useArt(sprite: SpriteAsset | null) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = sprite && failed !== sprite.path ? sprite : null;
  return { sprite: shown, onError: () => sprite && setFailed(sprite.path) };
}

/** The class names that colour a shown title (`title-colour.<name>`), or '' for none. */
export function titleColourClass(id: string | null | undefined): string {
  if (!id || findCosmetic(id)?.kind !== 'titleColour') return '';
  return `cosm-tint cosm-tint--${suffix(id)}`;
}

/** A hero's class portrait in its appearance. */
export function HeroLook({
  classId,
  palette,
  scale,
  alt,
  className,
}: {
  classId: ClassId;
  palette: string | null | undefined;
  scale: number;
  alt: string;
  className?: string;
}) {
  const swap = appearancePalette(palette, classId);
  return (
    <PixelSprite
      sprite={classPortrait(classId)}
      scale={scale}
      alt={alt}
      palette={swap}
      {...(className ? { className } : {})}
    />
  );
}

/** A banner style on its cloth (`colour`: the hero's banner dye, e.g. `ash`). */
export function BannerStyle({
  id,
  scale = 2,
  colour = 'ash',
}: {
  id: string | null | undefined;
  scale?: 1 | 2 | 3 | 4;
  colour?: string;
}) {
  const c = id ? findCosmetic(id) : undefined;
  const art = useArt(c?.kind === 'banner' ? bannerStyleSprite(c.id) : null);
  const size = 32 * scale;
  const label = c?.kind === 'banner' ? c.name : 'Plain banner';
  return (
    <span
      className={`cosm-banner banner-${colour}${art.sprite ? '' : ' cosm-banner--plain'}${
        c ? ` cosm-banner--${suffix(c.id)}` : ''
      }`}
      style={{ width: size, height: size + 8 * scale }}
      role="img"
      aria-label={label}
      data-cosmetic={c?.id ?? 'plain'}
    >
      <span className="cosm-banner__cloth" aria-hidden="true" />
      {art.sprite ? (
        <img
          className="cosm-banner__device pixel"
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

/** The crest style's frame around `children` (a portrait, a name plate). */
export function CrestRim({
  id,
  scale = 2,
  children,
}: {
  id: string | null | undefined;
  scale?: 1 | 2 | 3 | 4;
  children?: ReactNode;
}) {
  const c = id ? findCosmetic(id) : undefined;
  const art = useArt(c?.kind === 'crest' ? crestStyleSprite(c.id) : null);
  const size = 32 * scale;
  return (
    <span
      className={`cosm-crest${c ? ` cosm-crest--${suffix(c.id)}` : ' cosm-crest--none'}${
        art.sprite ? '' : ' cosm-crest--plain'
      }`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={c?.kind === 'crest' ? c.name : 'Plain crest'}
      data-cosmetic={c?.id ?? 'plain'}
    >
      <span className="cosm-crest__well">{children}</span>
      {art.sprite ? (
        <img
          className="cosm-crest__frame pixel"
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

/** In rows (boards, rosters): a small mark of the account's crest style; nothing when plain. */
export function CrestMark({ id }: { id: string | null | undefined }) {
  const c = id ? findCosmetic(id) : undefined;
  const art = useArt(c?.kind === 'crest' ? crestStyleSprite(c.id) : null);
  if (!c || c.kind !== 'crest') return null;
  return (
    <span
      className={`cosm-crestmark cosm-crest--${suffix(c.id)}${art.sprite ? '' : ' cosm-crest--plain'}`}
      title={c.name}
      role="img"
      aria-label={c.name}
    >
      {art.sprite ? (
        <img
          className="cosm-crestmark__art"
          src={art.sprite.path}
          alt=""
          width={16}
          height={16}
          draggable={false}
          onError={art.onError}
        />
      ) : null}
    </span>
  );
}
