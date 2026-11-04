import type { BannerId } from '@worldforge/game-core';
import { PixelSprite } from '../components/PixelSprite';
import { ASSETS } from '../content/assets';

/**
 * A character's portrait in front of their banner. Every class uses the warrior art until class
 * portraits exist (ticket 1.3); the banner colour is the one cosmetic choice.
 */
export function HeroPortrait({
  banner,
  scale,
  alt,
}: {
  banner: BannerId;
  scale: number;
  alt: string;
}) {
  return (
    <div className={`hero-portrait banner-${banner}`}>
      <span className="hero-portrait__banner" aria-hidden="true" />
      <PixelSprite
        sprite={ASSETS['character.warrior']}
        scale={scale}
        alt={alt}
        className="hero-portrait__sprite"
      />
    </div>
  );
}
