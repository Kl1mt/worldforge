import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { CORE_STATS, type CoreStatId } from '@worldforge/game-core';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { slotName, toItemView, type ItemView } from '../game/items';
import type { ItemDto } from '../game/api';
import { toolsApi } from '../admin/tools-api';
import { materialName, nf } from '../admin/tools-view';
import { formatStatValue } from '../lib/format';
import { formatWhen } from '../social/api';
import { Failed, Waiting, useAdminLoad } from './AdminToolKit';
import { areaName, className } from './AdminHeroTools';
import { getDungeon, isDungeonId } from '@worldforge/game-core';

/**
 * Ticket D.4: "View as player". The hero's sheet as the server would show it to the player:
 * gear, pack, stats, materials, warehouse, open places and activity. Read-only by construction:
 * this view renders no action at all, only a way back to the file.
 */
export function ViewAsSheet({
  handle,
  characterId,
  onBack,
}: {
  handle: string;
  characterId: string;
  onBack: () => void;
}) {
  const fetcher = useCallback(
    (signal: AbortSignal) => toolsApi.viewAs(handle, characterId, signal),
    [handle, characterId],
  );
  const [state, reload] = useAdminLoad(fetcher);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);

  return (
    <article className="adt-viewas panel-iron" aria-labelledby="adt-viewas-title">
      <div className="adt-viewas__band" role="note">
        <span className="caps">Read-only view</span> Nothing here can change the game.
      </div>
      <div className="adt-viewas__top">
        <button type="button" className="btn btn--small" onClick={onBack}>
          ← Back to the file
        </button>
      </div>
      {state.kind === 'loading' ? <Waiting>Looking through their eyes…</Waiting> : null}
      {state.kind === 'error' ? (
        <Failed what="The hero sheet could not be read." error={state.error} onRetry={reload} />
      ) : null}
      {state.kind === 'ready' ? (
        <SetPackContext.Provider
          value={{
            equipped: state.value.inventory.equipped.map(toItemView),
            items: state.value.inventory.inventory.map(toItemView),
          }}
        >
          <header className="adt-viewas__head">
            <p className="caps">
              As @{handle} sees it{state.value.deleted ? ' · deleted hero' : ''}
            </p>
            <h2 id="adt-viewas-title" className="display" tabIndex={-1} ref={head}>
              {state.value.character.name}
            </h2>
            <p className="adt-dim">
              Level {state.value.character.level} {className(state.value.character.classId)} ·{' '}
              {nf(state.value.character.experience)} XP · {nf(state.value.character.gold)} gold
            </p>
          </header>

          <div className="adt-viewas__cols">
            <section aria-labelledby="adt-va-gear">
              <h3 id="adt-va-gear" className="rule-heading">
                Equipped
              </h3>
              <Sockets items={state.value.inventory.equipped} empty="Nothing equipped." worn />
              <h3 className="rule-heading">Pack</h3>
              <Sockets items={state.value.inventory.inventory} empty="The pack is empty." />
              <h3 className="rule-heading">Warehouse</h3>
              <Sockets items={state.value.warehouse} empty="The warehouse is empty." />
            </section>

            <section aria-labelledby="adt-va-stats">
              <h3 id="adt-va-stats" className="rule-heading">
                Attributes
              </h3>
              <dl className="adt-sheet">
                {CORE_STATS.map((s) => {
                  const v = state.value.inventory.stats[s.id as CoreStatId];
                  return typeof v === 'number' ? (
                    <div key={s.id}>
                      <dt>{s.name}</dt>
                      <dd>{formatStatValue(s.id, v)}</dd>
                    </div>
                  ) : null;
                })}
              </dl>
              <h3 className="rule-heading">Materials</h3>
              {Object.values(state.value.materials).every((n) => !n) ? (
                <p className="adt-none">No materials.</p>
              ) : (
                <dl className="adt-sheet">
                  {Object.entries(state.value.materials)
                    .filter(([, n]) => n > 0)
                    .map(([id, n]) => (
                      <div key={id}>
                        <dt>{materialName(id)}</dt>
                        <dd>{nf(n)}</dd>
                      </div>
                    ))}
                </dl>
              )}
              <h3 className="rule-heading">Activity</h3>
              {state.value.activity ? (
                <p>
                  Farming {areaName(state.value.activity.areaId)}, last settled{' '}
                  {formatWhen(state.value.activity.settledAt)}.
                </p>
              ) : (
                <p className="adt-none">Not farming.</p>
              )}
              <h3 className="rule-heading">Places</h3>
              <ul className="adt-places">
                {state.value.areas.map((a) => (
                  <li key={a.id} className={a.unlocked ? 'is-open' : 'is-shut'}>
                    <span aria-hidden="true">{a.unlocked ? '◆' : '◇'}</span> {areaName(a.id)}
                    <span className="visually-hidden">{a.unlocked ? ', open' : ', locked'}</span>
                  </li>
                ))}
                {state.value.dungeons.map((d) => (
                  <li key={`${d.id}.${d.tier}`} className={d.unlocked ? 'is-open' : 'is-shut'}>
                    <span aria-hidden="true">{d.unlocked ? '◆' : '◇'}</span>{' '}
                    {isDungeonId(d.id) ? getDungeon(d.id).name : d.id}, tier{' '}
                    {['I', 'II', 'III'][d.tier - 1] ?? d.tier}
                    <span className="visually-hidden">{d.unlocked ? ', open' : ', locked'}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </SetPackContext.Provider>
      ) : null}
    </article>
  );
}

/** The viewed hero's gear, so set tooltips count their pieces, not the admin's own hero's. */
const SetPackContext = createContext<{ equipped: ItemView[]; items: ItemView[] } | null>(null);

function Sockets({ items, empty, worn }: { items: ItemDto[]; empty: string; worn?: boolean }) {
  const pack = useContext(SetPackContext);
  if (items.length === 0) return <p className="adt-none">{empty}</p>;
  return (
    <ul className="adt-sockets">
      {items.map((dto) => {
        const item = toItemView(dto);
        return (
          <li key={dto.id}>
            <details className="adt-socket">
              <summary aria-label={`${item.name}, ${item.rarity}: details`}>
                <ItemFrame
                  item={item}
                  scale={1}
                  {...(worn && item.equippedSlot ? { context: slotName(item.equippedSlot) } : {})}
                />
              </summary>
              <ItemTooltip item={item} {...(pack ? { setPack: pack } : {})} />
            </details>
          </li>
        );
      })}
    </ul>
  );
}
