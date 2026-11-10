import { useState } from 'react';
import { findCosmetic, type BannerId, type ClassId } from '@worldforge/game-core';
import { PixelSprite } from '../components/PixelSprite';
import { classPortrait } from '../content/assets';
import { appearancePalette, bannerStyleSprite } from '../content/appearance';

/**
 * A character's class portrait in front of their banner; the banner colour is chosen at creation.
 * Ticket 6.8: the hero's appearance (a palette swap) and the account's banner style (a 32×32
 * device sewn on the banner at ×2) from the collection book; without art, own colours and a plain
 * banner.
 */
export function HeroPortrait({
  classId,
  banner,
  scale,
  alt,
  palette = null,
  bannerStyle = null,
}: {
  classId: ClassId;
  banner: BannerId;
  scale: number;
  alt: string;
  palette?: string | null;
  bannerStyle?: string | null;
}) {
  const style = bannerStyle && findCosmetic(bannerStyle)?.kind === 'banner' ? bannerStyle : null;
  const device = style ? bannerStyleSprite(style) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const showDevice = device !== null && failed !== device.path;
  return (
    <div
      className={`hero-portrait banner-${banner}`}
      {...(style ? { 'data-banner-style': style } : {})}
    >
      <span className="hero-portrait__banner" aria-hidden="true">
        {showDevice ? (
          <img
            className="hero-portrait__device pixel"
            src={device.path}
            alt=""
            width={64}
            height={64}
            draggable={false}
            onError={() => setFailed(device.path)}
          />
        ) : null}
      </span>
      <PixelSprite
        sprite={classPortrait(classId)}
        scale={scale}
        alt={alt}
        className="hero-portrait__sprite"
        palette={appearancePalette(palette, classId)}
      />
    </div>
  );
}
