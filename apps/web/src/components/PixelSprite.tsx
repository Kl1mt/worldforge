import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { SpriteAsset } from '../content/assets';

interface PixelSpriteProps {
  sprite: SpriteAsset;
  /** Integer scale factor; fractional values are floored (docs/ASSET_GUIDELINES.md). */
  scale: number;
  /** Accessible name; pass an empty string for decorative sprites. */
  alt: string;
  mirror?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Renders pixel art at an integer scale with nearest-neighbour sampling. */
export function PixelSprite({ sprite, scale, alt, mirror, className, style }: PixelSpriteProps) {
  const [failed, setFailed] = useState(false);
  const s = Math.max(1, Math.floor(scale));
  const width = sprite.width * s;
  const height = sprite.height * s;

  if (failed) {
    return (
      <span
        className={['pixel-missing', className].filter(Boolean).join(' ')}
        style={{ width, height, ...style }}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
      >
        {alt ? 'art missing' : null}
      </span>
    );
  }

  return (
    <img
      src={sprite.path}
      width={width}
      height={height}
      alt={alt}
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
      className={['pixel', mirror ? 'pixel--mirror' : '', className].filter(Boolean).join(' ')}
      style={style}
    />
  );
}
