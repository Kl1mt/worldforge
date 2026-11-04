import { useState } from 'react';
import {
  CORE_STATS,
  EQUIPMENT_SLOTS,
  MAX_LEVEL,
  RESOURCES,
  getClass,
  xpToNextLevel,
  type CoreStatId,
  type EquipmentSlotDefinition,
  type EquipmentSlotId,
} from '@worldforge/game-core';
import { useGame } from '../game/GameProvider';
import { equippedBySlot, type EquippedMap, type ItemView } from '../game/items';
import { classPortrait } from '../content/assets';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { LabeledMeter, Meter } from '../components/Meter';
import { ProfessionsPanel } from './ProfessionsPanel';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { formatNumber, formatStatValue } from '../lib/format';
import { routeHref } from '../lib/route';
import { DOLL_LARGE_MIN_WIDTH, pixelScale } from '../lib/pixel';
import { useActiveCharacter } from '../characters/CharactersProvider';
import './character.css';

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
  equipped,
}: {
  id: EquipmentSlotId;
  side: 'left' | 'right';
  scale: number;
  selected: boolean;
  onSelect: () => void;
  equipped: EquippedMap;
}) {
  const def = slotDef(id);
  const item = equipped[id];
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
  const hero = useActiveCharacter();
  const cls = getClass(hero.classId);
  const portrait = classPortrait(hero.classId);
  const xpToNext = hero.level < MAX_LEVEL ? xpToNextLevel(hero.level) : hero.experience;
  const resource = RESOURCES.find((r) => r.id === cls.resource);
  const { inventory, activity, unequip, reload } = useGame();
  const [selected, setSelected] = useState<EquipmentSlotId>('weapon');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [dollRef, dollWidth] = useElementWidth<HTMLElement>(0);
  // Desktop with room: portrait ×4 and sockets ×3. Otherwise the approved ×3 / ×2 (phones ×2).
  const large = dollWidth >= DOLL_LARGE_MIN_WIDTH;
  const [portraitRef, portraitWidth] = useElementWidth<HTMLDivElement>(384);
  const portraitScale = pixelScale(portraitWidth, portrait.width, { min: 2, max: large ? 4 : 3 });
  const slotScale = large ? 3 : 2;
  const ready = inventory.kind === 'ready' ? inventory.value : null;
  const equipped: EquippedMap = ready ? equippedBySlot(ready.equipped) : {};
  const selectedItem = equipped[selected];
  const statName = new Map(CORE_STATS.map((s) => [s.id, s.name]));
  const maxHealth = ready?.stats.health ?? 0;
  const carried = activity.kind === 'ready' ? (activity.value?.health ?? null) : null;
  const health = Math.min(maxHealth, carried ?? maxHealth);

  const select = (id: EquipmentSlotId) => {
    setSelected(id);
    setNotice(null);
  };

  const takeOff = async (item: ItemView) => {
    setBusy(true);
    setNotice(null);
    const failure = await unequip(item.id);
    setBusy(false);
    setNotice(
      failure
        ? { kind: 'error', text: failure }
        : { kind: 'ok', text: `${item.name} went back into the pack.` },
    );
  };

  return (
    <div className="char">
      <header className="char__head">
        <div>
          <p className="caps char__eyebrow">Character</p>
          <h1 className="char__name display">{hero.name}</h1>
          <p className="char__line">
            Level {hero.level} {cls.name}
            <span aria-hidden="true"> · </span>
            {resource?.name}
          </p>
        </div>
        <div className="char__xp">
          <div className="char__xp-text">
            <span className="caps">Experience</span>
            <span>
              {formatNumber(hero.experience)} / {formatNumber(xpToNext)}
            </span>
          </div>
          <Meter
            current={hero.experience}
            max={xpToNext}
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
                onSelect={() => select(id)}
                equipped={equipped}
              />
            ))}
          </ul>

          <div className="doll__niche" ref={portraitRef}>
            <PixelSprite
              sprite={portrait}
              scale={portraitScale}
              alt={`${hero.name} the ${cls.name}`}
              className="doll__hero"
            />
            <div className="doll__plaque">
              <span className="display doll__class">{cls.name}</span>
              <span className="doll__identity">{cls.identity}</span>
              <div className="doll__bars">
                {ready ? (
                  <LabeledMeter
                    current={health}
                    max={maxHealth}
                    label="Health"
                    value={`${formatNumber(health)} / ${formatNumber(maxHealth)}`}
                  />
                ) : null}
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
                onSelect={() => select(id)}
                equipped={equipped}
              />
            ))}
          </ul>
        </section>

        <aside className="char__side">
          <section className="ledger panel-iron" aria-labelledby="stats-title">
            <h2 id="stats-title" className="rule-heading">
              Attributes
            </h2>
            {inventory.kind === 'loading' ? (
              <p className="ledger__state" role="status">
                Tallying attributes…
              </p>
            ) : null}
            {inventory.kind === 'error' ? (
              <div className="ledger__state" role="alert">
                <p>{inventory.message}</p>
                <button type="button" className="btn" onClick={reload}>
                  Try again
                </button>
              </div>
            ) : null}
            {ready &&
              STAT_GROUPS.map((group) => (
                <div key={group.title} className="ledger__group">
                  <h3 className="caps">{group.title}</h3>
                  <dl>
                    {group.stats.map((id) => (
                      <div
                        key={id}
                        className={`ledger__row${ready.stats[id] === 0 ? ' is-zero' : ''}`}
                      >
                        <dt>{statName.get(id)}</dt>
                        <dd>{formatStatValue(id, ready.stats[id])}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
          </section>

          <ProfessionsPanel />

          <section className="inspect" aria-live="polite" aria-label="Selected slot">
            {selectedItem ? (
              <ItemTooltip item={selectedItem} caption={`Equipped · ${slotDef(selected).name}`}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void takeOff(selectedItem)}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {busy ? 'Unequipping…' : 'Unequip'}
                </button>
              </ItemTooltip>
            ) : (
              <div className="inspect__empty">
                <p className="caps">{slotDef(selected).name}</p>
                <p>
                  {inventory.kind === 'loading'
                    ? 'Checking this slot…'
                    : 'Nothing equipped. Items for this slot drop in the fields; equip them from the '}
                  {inventory.kind === 'loading' ? null : <a href={routeHref('inventory')}>pack</a>}
                  {inventory.kind === 'loading' ? null : '.'}
                </p>
              </div>
            )}
            {notice ? (
              <p
                className={`inspect__notice inspect__notice--${notice.kind}`}
                role={notice.kind === 'error' ? 'alert' : 'status'}
              >
                {notice.text}
              </p>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}
