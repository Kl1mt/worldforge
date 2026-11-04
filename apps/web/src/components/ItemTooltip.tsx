import { EQUIPMENT_SLOTS, RARITIES } from '@worldforge/game-core';
import { compareItems } from '../lib/compare';
import { formatStatDelta, formatStatValue, statDefinition } from '../lib/format';
import type { ItemSlotKind, MockItem } from '../mock/items';
import './item-tooltip.css';

const RARITY_NAME = new Map(RARITIES.map((r) => [r.id, r.name]));

function slotName(slot: ItemSlotKind): string {
  if (slot === 'ring') return 'Ring';
  return EQUIPMENT_SLOTS.find((s) => s.id === slot)?.name ?? slot;
}

interface ItemTooltipProps {
  item: MockItem;
  /** When set, a comparison block shows the change if `item` replaced it. */
  compareTo?: MockItem | null;
  /** Small caption above the tooltip, e.g. "Equipped". */
  caption?: string;
  id?: string;
}

export function ItemTooltip({ item, compareTo, caption, id }: ItemTooltipProps) {
  const deltas = compareTo !== undefined ? compareItems(item, compareTo ?? undefined) : null;
  const rarity = RARITY_NAME.get(item.rarity) ?? item.rarity;

  return (
    <article
      className={`tooltip rarity-${item.rarity}`}
      id={id}
      aria-label={`${item.name} details`}
    >
      <div className="tooltip__body">
        {caption ? <p className="tooltip__caption caps">{caption}</p> : null}
        <header className="tooltip__head">
          <h3 className="tooltip__name">{item.name}</h3>
          <p className="tooltip__type">
            <span className="tooltip__rarity">{rarity}</span> {item.baseType}
          </p>
          <p className="tooltip__meta">
            {slotName(item.slot)} <span aria-hidden="true">·</span> Item level {item.itemLevel}
          </p>
        </header>

        {item.base.length > 0 ? (
          <dl className="tooltip__base">
            {item.base.map((line) => (
              <div key={line.stat}>
                <dt>{statDefinition(line.stat).name}</dt>
                <dd>{formatStatValue(line.stat, line.value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {item.affixes.length > 0 ? (
          <ul className="tooltip__affixes" aria-label="Affixes">
            {item.affixes.map((line) => (
              <li key={line.stat}>
                <span className="tooltip__affix-value">
                  {formatStatDelta(line.stat, line.value)}
                </span>{' '}
                {statDefinition(line.stat).name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="tooltip__plain">No affixes.</p>
        )}

        {item.unique ? <p className="tooltip__unique">{item.unique}</p> : null}
        {item.flavor ? <p className="tooltip__flavor">“{item.flavor}”</p> : null}

        {deltas ? (
          <section className="tooltip__compare" aria-label="Comparison with equipped item">
            <p className="caps">
              {compareTo ? (
                <>If equipped, replacing {compareTo.name}</>
              ) : (
                'If equipped (slot is empty)'
              )}
            </p>
            {deltas.length === 0 ? (
              <p className="tooltip__plain">No stat change.</p>
            ) : (
              <ul>
                {deltas.map((d) => (
                  <li key={d.stat} className={d.value > 0 ? 'is-up' : 'is-down'}>
                    <span aria-hidden="true">{d.value > 0 ? '▲' : '▼'}</span>
                    <span className="visually-hidden">{d.value > 0 ? 'Gain' : 'Loss'}</span>
                    <span className="tooltip__delta">{formatStatDelta(d.stat, d.value)}</span>
                    {statDefinition(d.stat).name}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </article>
  );
}
