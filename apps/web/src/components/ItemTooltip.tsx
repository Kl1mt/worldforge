import type { ReactNode } from 'react';
import { RARITIES, UPGRADE_IMPLICIT_BONUS } from '@worldforge/game-core';
import {
  MYTHIC_SOURCES,
  SET_SOURCES,
  STAT_GROUP_NAMES,
  compareItems,
  groupAffixes,
  setTracker,
  slotName,
  type ItemView,
  type StatLine,
} from '../game/items';
import { useOptionalGame } from '../game/GameProvider';
import { SetTracker } from './SetTracker';
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

/** Small marks for forge work on an affix (ticket 3.4): improvement pips and a reroll sign. */
function ForgeMarks({ line }: { line: StatLine }) {
  if (!line.improvements && !line.rerolled) return null;
  const said = [
    line.improvements ? `improved ${line.improvements}×` : null,
    line.rerolled ? 'reworked at the forge' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <span className="tooltip__forge" title={said}>
      <span aria-hidden="true">
        {line.rerolled ? '↻' : ''}
        {'▴'.repeat(line.improvements ?? 0)}
      </span>
      <span className="visually-hidden">({said})</span>
    </span>
  );
}

export function ItemTooltip({ item, compareTo, caption, note, children, id }: ItemTooltipProps) {
  const deltas = compareTo !== undefined ? compareItems(item, compareTo ?? undefined) : null;
  const rarity = RARITY_NAME.get(item.rarity) ?? item.rarity;
  // Set pieces (ticket 3.3): progress from the character's pack when the tooltip has one.
  const game = useOptionalGame();
  const pack = game?.inventory.kind === 'ready' ? game.inventory.value : null;
  const set = item.setId ? setTracker(item.setId, pack?.equipped ?? [], pack?.items ?? []) : null;

  return (
    <article
      className={`tooltip rarity-${item.rarity}`}
      id={id}
      aria-label={`${item.name} details`}
    >
      <div className="tooltip__body">
        {caption ? <p className="tooltip__caption caps">{caption}</p> : null}
        <header className="tooltip__head">
          <h3 className="tooltip__name">
            {item.name}
            {item.upgradeLevel > 0 ? (
              <span className="tooltip__upgrade"> +{item.upgradeLevel}</span>
            ) : null}
          </h3>
          <p className="tooltip__type">
            {item.variant ? <span className="tooltip__variant">{item.variant.name} </span> : null}
            <span className="tooltip__rarity">{set ? `${rarity} set piece` : rarity}</span>{' '}
            {item.slot ? slotName(item.slot) : 'Relic of a lost age'}
          </p>
          <p className="tooltip__meta">
            Item level {item.itemLevel}
            {item.upgradeLevel > 0 ? (
              <> · base values +{Math.round(UPGRADE_IMPLICIT_BONUS[item.upgradeLevel]! * 100)} %</>
            ) : null}
          </p>
          {item.uniqueSource ? (
            <p className="tooltip__unique">
              <span className="caps">Unique boss drop</span> Only {item.uniqueSource} drops this.
            </p>
          ) : null}
          {item.effect?.kind === 'mythic' ? (
            <p className="tooltip__unique">
              <span className="caps">Mythic</span> One of a handful, found only in {MYTHIC_SOURCES}.
            </p>
          ) : null}
          {set ? (
            <p className="tooltip__unique">
              <span className="caps">Set piece</span> Found in {SET_SOURCES}.
            </p>
          ) : null}
          {item.variant ? (
            <p className="tooltip__unique tooltip__unique--void">
              <span className="caps">◇ {item.variant.name}</span> Touched by the void: base values +
              {Math.round(item.variant.implicitBonus * 100)} %
              {item.variant.effectBonus > 0
                ? `, ${item.effect?.kind === 'mythic' ? 'signature' : 'effect'} +${Math.round(item.variant.effectBonus * 100)} %`
                : ''}
              {set ? '. Still counts as the same set piece.' : '.'}
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
                      <ForgeMarks line={line} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="tooltip__plain">No affixes.</p>
        )}

        {item.effect ? (
          <section
            className="tooltip__effect"
            aria-label={item.effect.kind === 'mythic' ? 'Mythic signature' : 'Legendary effect'}
          >
            <p className="tooltip__effect-kind caps">
              {item.effect.kind === 'mythic' ? 'Signature' : 'Legendary effect'}
            </p>
            <p className="tooltip__effect-name">{item.effect.name}</p>
            <p className="tooltip__effect-text">{item.effect.text}</p>
            {item.effect.kind === 'legendary' ? (
              <p className="tooltip__effect-note">Worn twice, only the stronger copy counts.</p>
            ) : null}
          </section>
        ) : null}

        {set ? (
          <div className="tooltip__set">
            <SetTracker set={set} current={item.baseId} compact headingLevel={4} />
          </div>
        ) : null}

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
