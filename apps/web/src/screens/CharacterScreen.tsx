import { useState } from 'react';
import {
  CORE_STATS,
  EQUIPMENT_SLOTS,
  RESOURCES,
  getClass,
  type CoreStatId,
  type EquipmentSlotDefinition,
  type EquipmentSlotId,
} from '@worldforge/game-core';
import { asset } from '../content/assets';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { LabeledMeter, Meter } from '../components/Meter';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { formatNumber, formatStatValue } from '../lib/format';
import { DOLL_LARGE_MIN_WIDTH, pixelScale } from '../lib/pixel';
import { CHARACTER } from '../mock/character';
import { EQUIPPED } from '../mock/items';
import './character.css';

const WARRIOR = asset('character.warrior');

/** Paper-doll sides: armour on the left, jewellery and arms on the right. */
const LEFT: EquipmentSlotId[] = ['head', 'shoulders', 'chest', 'hands', 'legs', 'feet'];
const RIGHT: EquipmentSlotId[] = ['neck', 'ring1', 'ring2', 'weapon', 'offhand', 'relic'];

const STAT_GROUPS: { title: string; stats: CoreStatId[] }[] = [
  {
    title: 'Offence',
    stats: ['physicalDamage', 'magicDamage', 'attackSpeed', 'critChance', 'critDamage'],
  },
  { title: 'Defence', stats: ['health', 'armor', 'resistance'] },
];

const slotDef = (id: EquipmentSlotId) =>
  EQUIPMENT_SLOTS.find((s) => s.id === id) as EquipmentSlotDefinition;

function Slot({
  id,
  side,
  scale,
  selected,
  onSelect,
}: {
  id: EquipmentSlotId;
  side: 'left' | 'right';
  scale: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const def = slotDef(id);
  const item = EQUIPPED[id];
  return (
    <li className={`slot slot--${side}${item ? '' : ' slot--empty'}`}>
      <ItemFrame
        item={item}
        scale={scale}
        emptyLabel={def.name}
        context={`${def.name} slot`}
        selected={selected}
        onSelect={onSelect}
      />
      <span className="slot__text" aria-hidden="true">
        <span className="slot__name caps">{def.name}</span>
        <span className={`slot__item${item ? ` rarity-${item.rarity}` : ''}`}>
          {item ? item.name : 'Empty'}
        </span>
      </span>
    </li>
  );
}

export function CharacterScreen() {
  const cls = getClass(CHARACTER.classId);
  const resource = RESOURCES.find((r) => r.id === cls.resource);
  const [selected, setSelected] = useState<EquipmentSlotId>('weapon');
  const [dollRef, dollWidth] = useElementWidth<HTMLElement>(0);
  // Desktop with room: portrait ×4 and sockets ×3. Otherwise the approved ×3 / ×2 (phones ×2).
  const large = dollWidth >= DOLL_LARGE_MIN_WIDTH;
  const [portraitRef, portraitWidth] = useElementWidth<HTMLDivElement>(384);
  const portraitScale = pixelScale(portraitWidth, WARRIOR.width, { min: 2, max: large ? 4 : 3 });
  const slotScale = large ? 3 : 2;
  const selectedItem = EQUIPPED[selected];
  const statName = new Map(CORE_STATS.map((s) => [s.id, s.name]));

  return (
    <div className="char">
      <header className="char__head">
        <div>
          <p className="caps char__eyebrow">Character</p>
          <h1 className="char__name display">{CHARACTER.name}</h1>
          <p className="char__line">
            Level {CHARACTER.level} {cls.name}
            <span aria-hidden="true"> · </span>
            {resource?.name}
          </p>
        </div>
        <div className="char__xp">
          <div className="char__xp-text">
            <span className="caps">Experience</span>
            <span>
              {formatNumber(CHARACTER.xp)} / {formatNumber(CHARACTER.xpToNext)}
            </span>
          </div>
          <Meter
            current={CHARACTER.xp}
            max={CHARACTER.xpToNext}
            label="Experience to next level"
            variant="xp"
          />
        </div>
      </header>

      <div className="char__body">
        <section
          className={`doll${large ? ' doll--large' : ''}`}
          aria-label="Equipment"
          ref={dollRef}
        >
          <ul className="doll__col doll__col--left">
            {LEFT.map((id) => (
              <Slot
                key={id}
                id={id}
                side="left"
                scale={slotScale}
                selected={selected === id}
                onSelect={() => setSelected(id)}
              />
            ))}
          </ul>

          <div className="doll__niche" ref={portraitRef}>
            <PixelSprite
              sprite={WARRIOR}
              scale={portraitScale}
              alt={`${CHARACTER.name}, a warrior in plate with a crimson cloak`}
              className="doll__hero"
            />
            <div className="doll__plaque">
              <span className="display doll__class">{cls.name}</span>
              <span className="doll__identity">{cls.identity}</span>
              <div className="doll__bars">
                <LabeledMeter
                  current={CHARACTER.health.current}
                  max={CHARACTER.health.max}
                  label="Health"
                  value={`${formatNumber(CHARACTER.health.current)} / ${formatNumber(CHARACTER.health.max)}`}
                />
                <LabeledMeter
                  current={CHARACTER.resource.current}
                  max={CHARACTER.resource.max}
                  label={resource?.name ?? 'Resource'}
                  value={`${formatNumber(CHARACTER.resource.current)} / ${formatNumber(CHARACTER.resource.max)}`}
                  variant="rage"
                />
              </div>
            </div>
          </div>

          <ul className="doll__col doll__col--right">
            {RIGHT.map((id) => (
              <Slot
                key={id}
                id={id}
                side="right"
                scale={slotScale}
                selected={selected === id}
                onSelect={() => setSelected(id)}
              />
            ))}
          </ul>
        </section>

        <aside className="char__side">
          <section className="ledger panel-iron" aria-labelledby="stats-title">
            <h2 id="stats-title" className="rule-heading">
              Attributes
            </h2>
            {STAT_GROUPS.map((group) => (
              <div key={group.title} className="ledger__group">
                <h3 className="caps">{group.title}</h3>
                <dl>
                  {group.stats.map((id) => (
                    <div
                      key={id}
                      className={`ledger__row${CHARACTER.stats[id] === 0 ? ' is-zero' : ''}`}
                    >
                      <dt>{statName.get(id)}</dt>
                      <dd>{formatStatValue(id, CHARACTER.stats[id])}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>

          <section className="inspect" aria-live="polite" aria-label="Selected slot">
            {selectedItem ? (
              <ItemTooltip item={selectedItem} caption={`Equipped · ${slotDef(selected).name}`} />
            ) : (
              <div className="inspect__empty">
                <p className="caps">{slotDef(selected).name}</p>
                <p>Nothing equipped. Items for this slot will drop in the fields.</p>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
