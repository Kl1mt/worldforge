import type { ReactNode } from 'react';
import { RARITIES } from '@worldforge/game-core';
import {
  STAT_GROUP_NAMES,
  compareItems,
  groupAffixes,
  slotName,
  type ItemView,
} from '../game/items';
import { formatStatDelta, formatStatValue, statDefinition } from '../lib/format';
import './item-tooltip.css';

const RARITY_NAME = new Map(RARITIES.map((r) => [r.id, r.name]));

interface ItemTooltipProps {
  item: ItemView;
  /**
   * When set, a comparison block shows the change if `item` replaced it (`null` = the target
   * slot is empty).
   */
  compareTo?: ItemView | null;
  /** Small caption above the tooltip, e.g. "Equipped". */
  caption?: string;
  /** A line under the header, e.g. "Warrior only". */
  note?: string;
  /** Actions at the foot of the plate (equip, unequip, discard). */
  children?: ReactNode;
  id?: string;
}

export function ItemTooltip({ item, compareTo, caption, note, children, id }: ItemTooltipProps) {
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
            <span className="tooltip__rarity">{rarity}</span>{' '}
            {item.slot ? slotName(item.slot) : 'Relic of a lost age'}
          </p>
          <p className="tooltip__meta">Item level {item.itemLevel}</p>
          {item.uniqueSource ? (
            <p className="tooltip__unique">
              <span className="caps">Unique boss drop</span> Only {item.uniqueSource} drops this.
            </p>
          ) : null}
          {note ? <p className="tooltip__note">{note}</p> : null}
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
          <div className="tooltip__affixes" aria-label="Affixes">
            {groupAffixes(item.affixes).map(({ group, lines }) => (
              <section key={group} className="tooltip__group" aria-label={STAT_GROUP_NAMES[group]}>
                <p className="tooltip__group-name caps">{STAT_GROUP_NAMES[group]}</p>
                <ul>
                  {lines.map((line, i) => (
                    <li key={`${line.stat}-${i}`}>
                      <span className="tooltip__affix-value">
                        {formatStatDelta(line.stat, line.value)}
                      </span>{' '}
                      {line.label ?? statDefinition(line.stat).name}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="tooltip__plain">No affixes.</p>
        )}

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

        {children ? <div className="tooltip__actions">{children}</div> : null}
      </div>
    </article>
  );
}
