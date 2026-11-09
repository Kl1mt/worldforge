import type { CSSProperties } from 'react';
import { findSprite } from '../content/assets';
import type { ItemView } from '../game/items';
import { PixelSprite } from './PixelSprite';
import './item-frame.css';

interface ItemFrameProps {
  item:
    | (Pick<ItemView, 'icon' | 'name' | 'rarity'> & {
        upgradeLevel?: number;
        /** Ticket 3.5: a Void item gets the void overlay (only when the variant applies). */
        variant?: ItemView['variant'];
        /** Ticket 3.7: a padlock in the upper right corner. */
        locked?: boolean;
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
}: ItemFrameProps) {
  const size = 32 * scale;
  // One art pixel in CSS pixels, for the Void edge (`--px`).
  const px = { '--px': `${Math.max(1, Math.floor(scale))}px` } as CSSProperties;
  const classes = [
    'item-frame',
    item ? `rarity-${item.rarity}` : 'item-frame--empty',
    selected ? 'item-frame--selected' : '',
    onSelect ? 'item-frame--interactive' : '',
    item && isNew ? 'item-frame--new' : '',
    item?.variant ? `item-frame--${item.variant.id}` : '',
    item?.locked ? 'item-frame--locked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const upgrade = item?.upgradeLevel ?? 0;
  const variant = item?.variant ? `${item.variant.name} ` : '';
  const label = item
    ? `${context ? `${context}: ` : ''}${item.name}${upgrade > 0 ? ` +${upgrade}` : ''}, ${variant}${item.rarity}${item.locked ? ', locked' : ''}${isNew ? ', new' : ''}`
    : `${context ?? 'Empty slot'}${emptyLabel && !context ? `: ${emptyLabel}` : ''}, empty`;

  const tag =
    item && isNew ? (
      <span className="item-frame__new" aria-hidden="true">
        New
      </span>
    ) : null;
  const art = item?.icon ? (
    <PixelSprite sprite={findSprite(item.icon)!} scale={scale} alt="" />
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
  // Ticket 3.5: the Void mark, a hollow diamond (shape, not only colour).
  const voidMark = item?.variant ? (
    <span className="item-frame__variant" aria-hidden="true">
      ◇
    </span>
  ) : null;
  // Ticket 3.7: a small iron padlock (shape, not colour) in the upper right corner.
  const lockMark = item?.locked ? <span className="item-frame__lock" aria-hidden="true" /> : null;
  const inner = (
    <>
      {art}
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
