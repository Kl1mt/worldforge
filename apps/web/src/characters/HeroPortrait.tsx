import type { BannerId, ClassId } from '@worldforge/game-core';
import { PixelSprite } from '../components/PixelSprite';
import { classPortrait } from '../content/assets';

/** A character's class portrait in front of their banner; the banner colour is the one cosmetic choice. */
export function HeroPortrait({
  classId,
  banner,
  scale,
  alt,
}: {
  classId: ClassId;
  banner: BannerId;
  scale: number;
  alt: string;
}) {
  return (
    <div className={`hero-portrait banner-${banner}`}>
      <span className="hero-portrait__banner" aria-hidden="true" />
      <PixelSprite
        sprite={classPortrait(classId)}
        scale={scale}
        alt={alt}
        className="hero-portrait__sprite"
      />
    </div>
  );
}
