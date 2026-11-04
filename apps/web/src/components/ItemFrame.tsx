import { asset } from '../content/assets';
import type { ItemView } from '../game/items';
import { PixelSprite } from './PixelSprite';
import './item-frame.css';

interface ItemFrameProps {
  item: Pick<ItemView, 'icon' | 'name' | 'rarity'> | undefined;
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
}

/**
 * A square socket for one item. Rarity shows on the frame (border, corner notch, faint
 * wash) and never on the art itself. Interactive when `onSelect` is given.
 */
export function ItemFrame({
  item,
  scale = 2,
  emptyLabel,
  selected,
  onSelect,
  context,
  isNew,
}: ItemFrameProps) {
  const size = 32 * scale;
  const classes = [
    'item-frame',
    item ? `rarity-${item.rarity}` : 'item-frame--empty',
    selected ? 'item-frame--selected' : '',
    onSelect ? 'item-frame--interactive' : '',
    item && isNew ? 'item-frame--new' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const label = item
    ? `${context ? `${context}: ` : ''}${item.name}, ${item.rarity}${isNew ? ', new' : ''}`
    : `${context ?? 'Empty slot'}${emptyLabel && !context ? `: ${emptyLabel}` : ''}, empty`;

  const tag =
    item && isNew ? (
      <span className="item-frame__new" aria-hidden="true">
        New
      </span>
    ) : null;
  const art = item?.icon ? (
    <PixelSprite sprite={asset(item.icon)} scale={scale} alt="" />
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
  const inner = (
    <>
      {art}
      {tag}
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
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={classes} role="img" aria-label={label}>
      {inner}
    </span>
  );
}
