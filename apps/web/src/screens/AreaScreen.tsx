import { getClass } from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { asset } from '../content/assets';
import { ItemFrame } from '../components/ItemFrame';
import { LabeledMeter, Meter } from '../components/Meter';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { useMediaQuery } from '../components/useMediaQuery';
import { formatNumber } from '../lib/format';
import { PHONE_QUERY, pixelScale, sceneSpriteScale } from '../lib/pixel';
import { CHARACTER } from '../mock/character';
import { AREA, COMBAT_LOG, ENEMIES, RECENT_DROPS, ROSTER, type LogEntry } from '../mock/combat';
import './area.css';

const BACKDROP = asset('area.abandoned-fields');
const HERO = asset('character.warrior');

function Scene({ phone }: { phone: boolean }) {
  const hero = useActiveCharacter();
  const [ref, width] = useElementWidth<HTMLDivElement>(768);
  // Backdrop at ×N (even). Sprites match it on wider screens and stay at ×N/2 on phones.
  const scale = pixelScale(width, BACKDROP.width, { step: 2, min: 2, max: 4 });
  const spriteScale = sceneSpriteScale(scale, phone);
  const stageWidth = Math.min(Math.floor(width), BACKDROP.width * scale);
  const stageHeight = BACKDROP.height * scale;
  const backdropLeft = Math.round((stageWidth - BACKDROP.width * scale) / 2);
  const target = ENEMIES.find((e) => e.targeted);

  return (
    <div className={`scene${phone ? '' : ' scene--wide'}`} ref={ref}>
      <figure
        className="scene__stage"
        style={{ width: stageWidth || undefined, height: stageHeight }}
        aria-label={`${AREA.name}: you are fighting ${ENEMIES.length} enemies`}
      >
        <PixelSprite
          sprite={BACKDROP}
          scale={scale}
          alt=""
          className="scene__backdrop"
          style={{ left: backdropLeft }}
        />
        <div className="scene__ground" style={{ ['--px' as string]: `${spriteScale}px` }}>
          <div className="scene__hero">
            <PixelSprite
              sprite={HERO}
              scale={spriteScale}
              alt={`${hero.name}, ${getClass(hero.classId).name.toLowerCase()}`}
            />
          </div>
          <ul className="scene__foes" aria-label="Enemies">
            {ENEMIES.map((enemy) => {
              const sprite = asset(enemy.sprite);
              return (
                <li
                  key={enemy.uid}
                  className={`foe${enemy.targeted ? ' foe--target' : ''}`}
                  style={{ marginBottom: enemy.lift * spriteScale }}
                >
                  <div
                    className="foe__plate"
                    // Wide: the bar spans the middle of the sprite so neighbouring plates
                    // never touch. Phones keep the approved full-width bar.
                    style={{ width: Math.round(sprite.width * spriteScale * (phone ? 1 : 0.625)) }}
                  >
                    <span className="foe__name">{enemy.name}</span>
                    <Meter
                      current={enemy.health.current}
                      max={enemy.health.max}
                      label={`${enemy.name} health`}
                    />
                  </div>
                  {enemy.targeted ? (
                    <span className="foe__hit" aria-hidden="true">
                      112
                    </span>
                  ) : null}
                  <PixelSprite
                    sprite={sprite}
                    scale={spriteScale}
                    alt={`${enemy.name}, level ${enemy.level}`}
                    mirror={sprite.facing === 'right'}
                  />
                </li>
              );
            })}
          </ul>
        </div>
        <figcaption className="scene__hud">
          <span className="scene__hud-name">{hero.name}</span>
          <LabeledMeter
            current={CHARACTER.health.current}
            max={CHARACTER.health.max}
            label="Health"
            value={`${formatNumber(CHARACTER.health.current)} / ${formatNumber(CHARACTER.health.max)}`}
          />
          <LabeledMeter
            current={CHARACTER.resource.current}
            max={CHARACTER.resource.max}
            label="Rage"
            value={`${CHARACTER.resource.current} / ${CHARACTER.resource.max}`}
            variant="rage"
          />
        </figcaption>
        {target ? (
          <p className="visually-hidden">
            Current target: {target.name}, {target.health.current} of {target.health.max} health.
          </p>
        ) : null}
      </figure>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case 'hit':
      return (
        <>
          {entry.crit ? <span className="log__crit">Critical. </span> : null}
          {entry.source} strike {entry.target} for{' '}
          <b className={entry.crit ? 'log__num log__num--crit' : 'log__num'}>{entry.amount}</b>.
        </>
      );
    case 'struck':
      return (
        <>
          {entry.source} hits you for <b className="log__num log__num--hurt">{entry.amount}</b>.
        </>
      );
    case 'kill':
      return (
        <>
          <span className="log__kill">{entry.target} falls.</span>{' '}
          <span className="log__dim">+{entry.xp} XP</span>
        </>
      );
    case 'loot':
      return (
        <>
          Found <span className={`log__loot rarity-${entry.rarity}`}>[{entry.item}]</span>
        </>
      );
    case 'gold':
      return <span className="log__gold">+{entry.amount} gold</span>;
    case 'note':
      return <span className="log__note">{entry.text}</span>;
  }
}

function CombatLog() {
  return (
    <section className="log panel-ledger" aria-labelledby="log-title">
      <header className="log__head">
        <h2 id="log-title" className="display">
          Chronicle
        </h2>
        <span className="caps">Newest first</span>
      </header>
      {COMBAT_LOG.length === 0 ? (
        <p className="log__empty">The fields are quiet. Combat entries will appear here.</p>
      ) : (
        <ol className="log__list" aria-live="off">
          {COMBAT_LOG.map((entry) => (
            <li key={entry.id} className={`log__row log__row--${entry.kind}`}>
              <time className="log__time">{entry.t}</time>
              <p>
                <LogLine entry={entry} />
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function AreaScreen() {
  const phone = useMediaQuery(PHONE_QUERY);
  // Roster figures and spoils icons: ×1 on phones (approved), ×2 on wider screens.
  const smallArt = phone ? 1 : 2;
  return (
    <div className={`area${phone ? '' : ' area--wide'}`}>
      <header className="area__head">
        <p className="area__region caps">
          {AREA.region} <span aria-hidden="true">·</span> Danger {'I'.repeat(AREA.danger)}{' '}
          <span aria-hidden="true">·</span> Levels {AREA.levelRange}
        </p>
        <h1 className="area__title display">{AREA.name}</h1>
        <p className="area__desc">{AREA.description}</p>
        <dl className="area__pace">
          <div>
            <dt>Status</dt>
            <dd className="area__fighting">Fighting</dd>
          </div>
          <div>
            <dt>Kills / min</dt>
            <dd>4.2</dd>
          </div>
          <div>
            <dt>Drops this hour</dt>
            <dd>9</dd>
          </div>
        </dl>
      </header>

      <div className="area__grid">
        <Scene phone={phone} />
        <div className="area__log">
          <CombatLog />
        </div>

        <section className="roster" aria-labelledby="roster-title">
          <h2 id="roster-title" className="rule-heading">
            Foes of the Fields
          </h2>
          <ul className="roster__list">
            {ROSTER.map((foe) => {
              const sprite = asset(foe.sprite);
              return (
                <li key={foe.sprite} className="roster__foe">
                  <span className="roster__plinth">
                    <PixelSprite
                      sprite={sprite}
                      scale={smallArt}
                      alt=""
                      mirror={sprite.facing === 'right'}
                    />
                  </span>
                  <span className="roster__name">{foe.name}</span>
                  <span className="roster__count">{formatNumber(foe.slain)} slain</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="spoils" aria-labelledby="spoils-title">
          <h2 id="spoils-title" className="rule-heading">
            Recent spoils
          </h2>
          <ul className="spoils__list">
            {RECENT_DROPS.map((drop, i) => (
              <li key={i}>
                <ItemFrame item={drop} scale={smallArt} context="Recent drop" />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
