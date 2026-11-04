import { MATERIALS, getArea } from '@worldforge/game-core';
import { MaterialStack } from '../components/MaterialStack';
import { useGame } from '../game/GameProvider';
import { materialView } from '../game/materials';
import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import './materials.css';

/** Where a material comes from, for the ledger line. */
function whereFound(id: (typeof MATERIALS)[number]['id']): string {
  const def = MATERIALS.find((m) => m.id === id)!;
  if (def.source === 'bossDrop') return 'Taken from a dungeon boss';
  const areas = def.areas.map((a) => getArea(a).name).join(', ');
  return def.source === 'undeadDrop' ? `Undead in ${areas}` : areas;
}

/**
 * The Pack's materials tab (ticket 2.3): every stack the server holds for the character, then the
 * materials not found yet with where to look. Materials stack without a limit.
 */
export function MaterialsTab() {
  const { materials, reload } = useGame();

  if (materials.kind === 'loading') {
    return (
      <div className="stash__empty" role="status">
        <p className="display">Weighing the sacks…</p>
        <p>Counting your materials.</p>
      </div>
    );
  }
  if (materials.kind === 'error') {
    return (
      <div className="stash__empty" role="alert">
        <p className="display">The sacks will not open.</p>
        <p>{materials.message}</p>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }

  const held = new Map(materials.value.materials.map((m) => [m.materialId, m.quantity]));
  const owned = MATERIALS.filter((m) => (held.get(m.id) ?? 0) > 0);
  const missing = MATERIALS.filter((m) => !held.has(m.id));

  return (
    <div className="mats">
      {owned.length === 0 ? (
        <div className="stash__empty">
          <p className="display">No materials yet.</p>
          <p>
            Your hero gathers timber, herbs, hide and ore between fights, wherever the land has
            them.
          </p>
          <a className="btn" href={routeHref('area')}>
            Go to the fields
          </a>
        </div>
      ) : (
        <ul className="mats__list" aria-label="Materials held">
          {owned.map((def) => {
            const view = materialView(def.id);
            const qty = held.get(def.id)!;
            return (
              <li key={def.id} className="mats__row">
                <MaterialStack material={view} quantity={qty} scale={2} />
                <div className="mats__text">
                  <p className={`mats__name rarity-${view.rarity}`}>{view.name}</p>
                  <p className="mats__meta caps">
                    {view.source} · {whereFound(def.id)}
                  </p>
                  <p className="mats__desc">{view.description}</p>
                </div>
                <p className="mats__qty">
                  <span className="mats__qty-num">{formatNumber(qty)}</span>
                  <span className="caps"> held</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {missing.length > 0 ? (
        <section className="mats__missing" aria-labelledby="mats-missing">
          <h2 id="mats-missing" className="caps">
            Not found yet
          </h2>
          <ul>
            {missing.map((def) => {
              const view = materialView(def.id);
              return (
                <li key={def.id}>
                  <span className={`mats__name rarity-${view.rarity}`}>{view.name}</span>
                  <span className="mats__hint">{whereFound(def.id)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <p className="mats__foot">Materials stack without limit and do not take pack slots.</p>
    </div>
  );
}
