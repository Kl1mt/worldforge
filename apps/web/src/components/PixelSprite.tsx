import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { SpriteAsset } from '../content/assets';
import type { PaletteSwap } from '../content/appearance';
import { usePaletteSwap } from './paletteSwap';

interface PixelSpriteProps {
  sprite: SpriteAsset;
  /** Integer scale factor; fractional values are floored (docs/ASSET_GUIDELINES.md). */
  scale: number;
  /** Accessible name; pass an empty string for decorative sprites. */
  alt: string;
  mirror?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Drawn instead if `sprite` fails to load (A.14: a frame sheet falls back to the portrait). */
  fallback?: SpriteAsset;
  /**
   * Ticket 6.8: a hero appearance's colour swap, applied in code (`paletteSwap.ts`). Until the
   * swapped image is ready, or without a canvas, the sprite shows its own colours.
   */
  palette?: PaletteSwap | null;
}

/**
 * Renders pixel art at an integer scale with nearest-neighbour sampling.
 *
 * A frame sheet (`sprite.frames`, ticket A.14) is drawn as a one-frame window over the whole row:
 * it shows frame 0 at rest, and an ancestor's CSS plays the row with a `steps()` animation of the
 * strip (`.pixel-sheet__strip`, see `scene/scene-anim.css`): whole frames, integer scale.
 */
export function PixelSprite({
  sprite,
  scale,
  alt,
  mirror,
  className,
  style,
  fallback,
  palette,
}: PixelSpriteProps) {
  const [failed, setFailed] = useState(false);
  const swapped = usePaletteSwap(sprite.path, palette);
  const src = swapped ?? sprite.path;
  const s = Math.max(1, Math.floor(scale));
  const width = sprite.width * s;
  const height = sprite.height * s;

  if (failed && fallback && fallback !== sprite) {
    return (
      <PixelSprite
        sprite={fallback}
        scale={scale}
        alt={alt}
        {...(palette ? { palette } : {})}
        {...(mirror ? { mirror } : {})}
        {...(className ? { className } : {})}
        {...(style ? { style } : {})}
      />
    );
  }

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

  const frames = sprite.frames && sprite.frames > 1 ? Math.floor(sprite.frames) : 1;
  if (frames > 1) {
    return (
      <span
        className={['pixel-sheet', mirror ? 'pixel--mirror' : '', className]
          .filter(Boolean)
          .join(' ')}
        style={{
          width,
          height,
          ['--frames' as string]: frames,
          // A.14b: the frame's strike room sits outside the still's footprint (see `lead`).
          ...(sprite.lead
            ? { [mirror ? 'marginRight' : 'marginLeft']: -Math.floor(sprite.lead) * s }
            : {}),
          ...style,
        }}
      >
        <img
          src={src}
          width={width * frames}
          height={height}
          alt={alt}
          draggable={false}
          decoding="async"
          onError={() => setFailed(true)}
          className="pixel pixel-sheet__strip"
        />
      </span>
    );
  }

  return (
    <img
      src={src}
      width={width}
      height={height}
      alt={alt}
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
      {...(palette ? { 'data-palette': swapped ? 'applied' : 'pending' } : {})}
      className={[
        'pixel',
        mirror ? 'pixel--mirror' : '',
        sprite.tint ? `pixel--tint-${sprite.tint}` : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
    />
  );
}
