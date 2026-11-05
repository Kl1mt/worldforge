import { useEffect, useRef } from 'react';
import { ItemFrame } from '../components/ItemFrame';
import { MaterialStack } from '../components/MaterialStack';
import { formatDuration, formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import { useGame } from './GameProvider';
import { isChaseDrop, summaryItemView } from './items';
import { materialCounts, professionName } from './materials';
import './return-summary.css';

/** Most item icons shown in the dialog; the rest are counted. */
const ITEM_ICONS = 12;

/**
 * "While you were away": the server's return summary after an absence (GDD §9.1, §18). Every
 * number is the server's settlement; the client only lays it out. A native modal `<dialog>`, so
 * focus is trapped and Escape closes it.
 */
export function ReturnSummaryDialog({ heroName }: { heroName: string }) {
  const { returnSummary: summary, dismissReturn } = useGame();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !summary) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [summary]);

  if (!summary) return null;
  const away = Math.max(0, Date.parse(summary.until) - Date.parse(summary.since));
  const shown = summary.items.slice(-ITEM_ICONS).reverse().map(summaryItemView);
  // Legendary and Mythic finds get their own moment (ticket 3.2), even when older than the icons.
  const chase = summary.items
    .filter((i) => isChaseDrop(i.rarityId))
    .reverse()
    .map(summaryItemView);
  const unlisted = summary.itemsGained - shown.length;
  const lootGold = summary.goldGained - summary.goldSalvaged;
  const gathered = materialCounts(summary.materials);
  const crafts = Object.entries(summary.professions ?? {}).filter(
    ([, p]) => p && p.xpGained > 0,
  ) as [Parameters<typeof professionName>[0], { xpGained: number; levelsGained: number }][];

  return (
    <dialog
      ref={ref}
      className="return"
      aria-labelledby="return-title"
      onClose={dismissReturn}
      onCancel={dismissReturn}
    >
      <div className="return__plate">
        <header className="return__head">
          <p className="caps">While you were away · {formatDuration(away)}</p>
          <h2 id="return-title" className="display">
            {heroName} kept the fields
          </h2>
        </header>

        <dl className="return__tally">
          <div>
            <dt>Foes slain</dt>
            <dd>{formatNumber(summary.kills)}</dd>
          </div>
          <div>
            <dt>Experience</dt>
            <dd>+{formatNumber(summary.xpGained)}</dd>
          </div>
          <div>
            <dt>Gold</dt>
            <dd className="return__gold">+{formatNumber(summary.goldGained)}</dd>
          </div>
          <div>
            <dt>Items</dt>
            <dd>{formatNumber(summary.itemsGained)}</dd>
          </div>
        </dl>

        {summary.levelsGained > 0 ? (
          <p className="return__level">
            {summary.levelsGained === 1
              ? 'Gained a level.'
              : `Gained ${summary.levelsGained} levels.`}
          </p>
        ) : null}

        {chase.length > 0 ? (
          <section className="return__chase" aria-labelledby="return-chase">
            <h3 id="return-chase" className="caps">
              {chase.some((i) => i.rarity === 'mythic') ? 'A Mythic surfaced' : 'Legendary find'}
            </h3>
            <ul>
              {chase.map((item) => (
                <li key={item.id} className={`rarity-${item.rarity}`}>
                  <ItemFrame item={item} scale={2} context="Found" />
                  <span className="return__chase-text">
                    <span className="return__chase-name">{item.name}</span>
                    {item.effectName ? (
                      <span className="return__chase-effect">{item.effectName}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {shown.length > 0 ? (
          <section className="return__items" aria-label="Items found">
            <ul>
              {shown.map((item) => (
                <li key={item.id}>
                  <ItemFrame item={item} scale={1} context="Found" />
                </li>
              ))}
            </ul>
            {unlisted > 0 ? <p className="return__more">and {unlisted} more</p> : null}
          </section>
        ) : null}

        {gathered.length > 0 ? (
          <section className="return__materials" aria-labelledby="return-materials">
            <h3 id="return-materials" className="caps">
              Gathered
            </h3>
            <ul>
              {gathered.map(({ material, quantity }) => (
                <li key={material.id}>
                  <MaterialStack material={material} quantity={quantity} scale={1} sign="+" />
                  <span className="return__material-name">{material.name}</span>
                </li>
              ))}
            </ul>
            {crafts.length > 0 ? (
              <p className="return__crafts">
                {crafts.map(([id, p], i) => (
                  <span key={id}>
                    {i > 0 ? ' · ' : ''}
                    {professionName(id)} +{formatNumber(p.xpGained)} XP
                    {p.levelsGained > 0 ? (
                      <strong>
                        {' '}
                        ({p.levelsGained === 1 ? 'level up' : `+${p.levelsGained} levels`})
                      </strong>
                    ) : null}
                  </span>
                ))}
              </p>
            ) : null}
          </section>
        ) : null}

        <ul className="return__notes">
          <li>
            Fought for {formatDuration(summary.simulatedMs)}
            {summary.deaths > 0
              ? `, fell ${summary.deaths} ${summary.deaths === 1 ? 'time' : 'times'} and rose again`
              : ''}
            .
          </li>
          {summary.itemsSalvaged > 0 ? (
            <li>
              Pack full: {summary.itemsSalvaged}{' '}
              {summary.itemsSalvaged === 1 ? 'item was' : 'items were'} salvaged for{' '}
              {formatNumber(summary.goldSalvaged)} gold ({formatNumber(lootGold)} gold from loot).
            </li>
          ) : null}
          {summary.cappedMs > 0 ? (
            <li className="return__capped">
              Offline progress stops after the limit: {formatDuration(summary.cappedMs)} earned
              nothing.
            </li>
          ) : null}
        </ul>

        <footer className="return__actions">
          <button
            type="button"
            className="btn btn--brass"
            onClick={() => ref.current?.close()}
            autoFocus
          >
            Back to the fields
          </button>
          {summary.itemsGained > 0 || gathered.length > 0 ? (
            <a className="btn" href={routeHref('inventory')} onClick={() => ref.current?.close()}>
              Open the pack
            </a>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}
