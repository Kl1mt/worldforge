import { formatNumber } from '../lib/format';
import type { MaterialView } from '../game/materials';
import { PixelSprite } from './PixelSprite';
import './item-frame.css';
import './material-stack.css';

interface MaterialStackProps {
  material: MaterialView;
  quantity: number;
  /** Icon scale (icons are 32 px native). */
  scale?: number;
  /** Prefix for the quantity badge, e.g. "+" in the return summary. */
  sign?: string;
}

/**
 * One material stack: the icon in an item socket (rarity on the frame, like items) with the
 * quantity stamped in the corner.
 */
export function MaterialStack({ material, quantity, scale = 2, sign = '' }: MaterialStackProps) {
  const size = 32 * scale;
  return (
    <span
      className={`item-frame material-stack rarity-${material.rarity}`}
      role="img"
      aria-label={`${material.name}: ${sign}${formatNumber(quantity)}`}
    >
      {material.sprite ? (
        <PixelSprite sprite={material.sprite} scale={scale} alt="" />
      ) : (
        <span className="item-frame__empty" style={{ width: size, height: size }}>
          ?
        </span>
      )}
      <span className="material-stack__qty" aria-hidden="true">
        {sign}
        {formatNumber(quantity)}
      </span>
    </span>
  );
}
