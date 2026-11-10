import type { CSSProperties } from 'react';
import { findSprite } from '../content/assets';
import type { ItemView } from '../game/items';
import { PixelSprite } from './PixelSprite';
import {
  AWAKENED_MARK,
  emberClass,
  shimmerClass,
  VARIANT_MARK,
  variantTreatment,
  type ShimmerMode,
} from './itemVariant';
import './item-frame.css';

interface ItemFrameProps {
  item:
    | (Pick<ItemView, 'icon' | 'name' | 'rarity'> & {
        upgradeLevel?: number;
        /**
         * Ticket 3.5: a Void item gets the void overlay (only when the variant applies); ticket
         * A.12: a Prismatic item gets the opal tint and sweep.
         */
        variant?: ItemView['variant'];
        /** Ticket 3.7: a padlock in the upper right corner. */
        locked?: boolean;
        /** Ticket 6.5b: the ember treatment and the ☼ sigil. */
        awakened?: ItemView['awakened'];
      })
    | undefined;
  /** Icon scale (icons are 32 px native). */
  scale?: number;
  /** Shown in an empty frame, e.g. the slot name. */
  emptyLabel?: string;
  selected?: boolean;
  onSelect?: () => void;
  /** Accessible description of the frame's context, e.g. "Head slot". */
  context?: string;
  /** Not looked at yet on this device (ticket 2.7): a "New" tag on the socket. */
  isNew?: boolean;
  /** Ticket 3.7: shown but not selectable (e.g. a locked item in a sell picker). */
  disabled?: boolean;
  /**
   * Ticket A.12: whether the Prismatic sweep (and, 6.5b, the awakened ember glow) may move
   * (`itemVariant.ts`); `auto` in the game.
   */
  shimmer?: ShimmerMode;
}

/**
 * A square socket for one item. Rarity shows on the frame (border, corner notch, faint
 * wash) and never on the art itself. Interactive when `onSelect` is given. A Void item (ticket
 * 3.5) is the one exception: its art is drained and edged in voidlight, inside a dark rift, with a
 * hollow diamond in the lower left corner (docs/DESIGN_SYSTEM.md).
 */
export function ItemFrame({
  item,
  scale = 2,
  emptyLabel,
  selected,
  onSelect,
  context,
  isNew,
  disabled,
  shimmer = 'auto',
}: ItemFrameProps) {
  const size = 32 * scale;
  // One art pixel in CSS pixels, for the Void edge (`--px`).
  const px = { '--px': `${Math.max(1, Math.floor(scale))}px` } as CSSProperties;
  const treatment = variantTreatment(item?.variant?.id);
  const sprite = item?.icon ? findSprite(item.icon) : undefined;
  const classes = [
    'item-frame',
    item ? `rarity-${item.rarity}` : 'item-frame--empty',
    selected ? 'item-frame--selected' : '',
    onSelect ? 'item-frame--interactive' : '',
    item && isNew ? 'item-frame--new' : '',
    item?.variant ? `item-frame--${item.variant.id}` : '',
    // A.12 / A.12b: both variants move (Prismatic's sweep, Void's breath and motes).
    treatment ? shimmerClass(shimmer) : '',
    item?.locked ? 'item-frame--locked' : '',
    // Ticket 6.5b: awakened, on top of the rarity and any variant (it never replaces them).
    item?.awakened ? 'item-frame--awakened' : '',
    item?.awakened ? emberClass(shimmer) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const upgrade = item?.upgradeLevel ?? 0;
  const variant = item?.variant ? `${item.variant.name} ` : '';
  const label = item
    ? `${context ? `${context}: ` : ''}${item.name}${upgrade > 0 ? ` +${upgrade}` : ''}, ${item.awakened ? 'awakened ' : ''}${variant}${item.rarity}${item.locked ? ', locked' : ''}${isNew ? ', new' : ''}`
    : `${context ?? 'Empty slot'}${emptyLabel && !context ? `: ${emptyLabel}` : ''}, empty`;

  const tag =
    item && isNew ? (
      <span className="item-frame__new" aria-hidden="true">
        New
      </span>
    ) : null;
  const art = item?.icon ? (
    <PixelSprite sprite={sprite!} scale={scale} alt="" />
  ) : item ? (
    // No art for this item (its base left the content): a marked socket, not a broken image.
    <span className="item-frame__empty" style={{ width: size, height: size }}>
      ?
    </span>
  ) : (
    <span className="item-frame__empty" style={{ width: size, height: size }}>
      {emptyLabel}
    </span>
  );
  // Ticket 3.4: the upgrade level, engraved in the socket's corner.
  const mark =
    upgrade > 0 ? (
      <span className="item-frame__upgrade" aria-hidden="true">
        +{upgrade}
      </span>
    ) : null;
  // Ticket 3.5: the Void mark, a hollow diamond; A.12: Prismatic's open star (shape, not colour).
  const voidMark = item?.variant ? (
    <span className="item-frame__variant" aria-hidden="true">
      {VARIANT_MARK[treatment ?? 'void']}
    </span>
  ) : null;
  // Ticket A.12: Prismatic's layers. The tint and the sweep share the icon's grid cell and are
  // clipped to its alpha (no layout change); the opal hairline runs inside the rarity ring.
  const prism =
    treatment === 'prismatic' && sprite ? (
      <>
        <span className="item-frame__prism-ring" aria-hidden="true" />
        {(['tint', 'sheen'] as const).map((layer) => (
          <span
            key={layer}
            className={`item-frame__prism item-frame__prism--${layer}`}
            aria-hidden="true"
            style={{
              // The sprite's own box at PixelSprite's integer scale.
              width: sprite.width * Math.max(1, Math.floor(scale)),
              height: sprite.height * Math.max(1, Math.floor(scale)),
              maskImage: `url("${sprite.path}")`,
              WebkitMaskImage: `url("${sprite.path}")`,
            }}
          />
        ))}
      </>
    ) : null;
  // Ticket A.12b: Void's moving layers, behind the icon in its grid cell (no layout change): motes
  // pulled through the rift toward the centre, and a voidlight edge that breathes. Shown only while
  // motion is on; still, the icon's own static edge is drawn as before (item-frame.css).
  const voidBox = sprite
    ? {
        width: sprite.width * Math.max(1, Math.floor(scale)),
        height: sprite.height * Math.max(1, Math.floor(scale)),
      }
    : undefined;
  const voidLayers =
    treatment === 'void' && sprite ? (
      <>
        <span className="item-frame__void-motes" aria-hidden="true" style={voidBox} />
        <span className="item-frame__void-edge" aria-hidden="true" style={voidBox}>
          <span
            className="item-frame__void-edge-fill"
            style={{
              maskImage: `url("${sprite.path}")`,
              WebkitMaskImage: `url("${sprite.path}")`,
            }}
          />
        </span>
      </>
    ) : null;
  // Ticket 6.5b: the awakened mark, an ember sigil ☼ (a shape, distinct from ◇ and ✧), and the
  // smouldering line along the socket's base under the art.
  const ember = item?.awakened ? (
    <>
      <span className="item-frame__ember" aria-hidden="true" />
      <span className="item-frame__awakened" aria-hidden="true">
        {AWAKENED_MARK}
      </span>
    </>
  ) : null;
  // Ticket 3.7: a small iron padlock (shape, not colour) in the upper right corner.
  const lockMark = item?.locked ? <span className="item-frame__lock" aria-hidden="true" /> : null;
  const inner = (
    <>
      {voidLayers}
      {ember}
      {art}
      {prism}
      {tag}
      {mark}
      {voidMark}
      {lockMark}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={classes}
        aria-label={label}
        aria-pressed={selected ?? false}
        onClick={onSelect}
        disabled={disabled}
        style={px}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={classes} role="img" aria-label={label} style={px}>
      {inner}
    </span>
  );
}
