import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compareRarity, type ItemSlotKind, type MaterialId } from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { ItemTooltip } from '../components/ItemTooltip';
import { MaterialStack } from '../components/MaterialStack';
import { useGame, type Load } from '../game/GameProvider';
import type { ApiResult } from '../lib/api';
import {
  describeGameFailure,
  forgeApi,
  type ForgeState,
  type MaterialStackDto,
  type RecipeDto,
} from '../game/api';
import { ActionKeys, isUncertain, itemsAction } from '../game/economy';
import { slotName, toItemView, type ItemView } from '../game/items';
import { materialView } from '../game/materials';
import { ItemPicker } from './economy/ItemPicker';
import { ForgeWork } from './economy/ForgeWork';
import { AwakenPanel } from './economy/AwakenPanel';
import { EngravePanel } from './economy/EngravePanel';
import { ExchangePanel } from './economy/ExchangePanel';
import { Gold, NoticeLine, ShopHeader, type Notice } from './economy/ShopHeader';
import './economy/shop.css';

// Ticket 8.2: tier V (the Crownforged Work).
const TIER_NAME = ['', 'Tier I', 'Tier II', 'Tier III', 'Tier IV', 'Tier V'];

function addStacks(into: Map<MaterialId, number>, stacks: readonly MaterialStackDto[]) {
  for (const s of stacks) into.set(s.materialId, (into.get(s.materialId) ?? 0) + s.quantity);
}

/**
 * The Forge (ticket 2.6): salvage pack items into materials and a little gold, and craft gear of a
 * tier in a chosen slot. Ticket 3.4 adds the anvil: upgrades, affix rerolls and improvements.
 */
export function ForgeScreen() {
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const { inventory, applyInventory, refreshMaterials } = useGame();
  const [state, setState] = useState<Load<ForgeState>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [slots, setSlots] = useState<Record<string, ItemSlotKind>>({});
  const [crafted, setCrafted] = useState<ItemView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Ticket 6.11: an exchange purchase re-reads the engraver's quote (same Seals and silver).
  const [spent, setSpent] = useState(0);
  const keys = useRef(new ActionKeys()).current;

  const apply = useCallback((res: ApiResult<ForgeState>) => {
    setState((prev) =>
      res.ok
        ? { kind: 'ready', value: res.value }
        : // A failed refresh keeps the shown state; only a first load shows the error.
          prev.kind === 'ready'
          ? prev
          : { kind: 'error', message: describeGameFailure(res.error) },
    );
  }, []);
  /** Re-reads the building after an action (sold-out flags, quotes, blockers). */
  const load = useCallback(() => {
    void forgeApi.get(hero.id).then(apply);
  }, [hero.id, apply]);

  useEffect(() => {
    const controller = new AbortController();
    forgeApi.get(hero.id, { signal: controller.signal }).then(apply, () => {
      /* aborted */
    });
    return () => controller.abort();
  }, [hero.id, apply, attempt]);

  const ready = state.kind === 'ready' ? state.value : null;
  const items = useMemo(
    () => (inventory.kind === 'ready' ? inventory.value.items : []),
    [inventory],
  );
  const pickedIds = [...picked].filter((id) => items.some((i) => i.id === id));
  const quotes = useMemo(() => new Map((ready?.salvage ?? []).map((q) => [q.itemId, q])), [ready]);
  const preview = useMemo(() => {
    const mats = new Map<MaterialId, number>();
    let gold = 0;
    for (const id of pickedIds) {
      const q = quotes.get(id);
      if (!q) continue;
      gold += q.gold;
      addStacks(mats, q.materials);
    }
    return {
      gold,
      materials: [...mats].map(([materialId, quantity]) => ({ materialId, quantity })),
    };
  }, [pickedIds, quotes]);
  const precious = pickedIds.filter((id) => {
    const item = items.find((i) => i.id === id);
    return item && compareRarity(item.rarity, 'rare') >= 0;
  }).length;
  const held = useMemo(
    () => new Map((ready?.materials ?? []).map((m) => [m.materialId, m.quantity])),
    [ready],
  );

  const salvage = async () => {
    if (precious > 0 && !confirm) {
      setConfirm(true);
      return;
    }
    const action = itemsAction('salvage', pickedIds);
    setBusy('salvage');
    setNotice(null);
    setConfirm(false);
    const res = await forgeApi.salvage(hero.id, pickedIds, keys.keyFor(action));
    keys.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) {
      updateCharacter(res.value.character);
      applyInventory(res.value.inventory);
      refreshMaterials();
      setPicked(new Set());
      const got = res.value.salvaged.materials
        .map((m) => `${m.quantity} ${materialView(m.materialId).name}`)
        .join(', ');
      setNotice({
        kind: 'ok',
        text: `Broken down for ${got || 'nothing usable'} and ${res.value.salvaged.gold} gold.`,
      });
    } else {
      setNotice({ kind: 'error', text: describeGameFailure(res.error) });
    }
    load();
  };

  const craft = async (recipe: RecipeDto, slot: ItemSlotKind) => {
    const action = `craft:${recipe.recipeId}:${slot}`;
    setBusy(action);
    setNotice(null);
    const res = await forgeApi.craft(hero.id, recipe.recipeId, slot, keys.keyFor(action));
    keys.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) {
      updateCharacter(res.value.character);
      applyInventory(res.value.inventory);
      refreshMaterials();
      const item = toItemView(res.value.item);
      setCrafted(item);
      setNotice({ kind: 'ok', text: `The smith hands you ${item.name}. It is in your pack.` });
    } else {
      setNotice({
        kind: 'error',
        text: isUncertain(res.error)
          ? `${describeGameFailure(res.error)} Crafting again is safe: nothing is spent twice.`
          : describeGameFailure(res.error),
      });
    }
    load();
  };

  let recipes;
  if (state.kind === 'loading') {
    recipes = (
      <div className="shop__empty" role="status">
        <p className="display">Stoking the fire…</p>
      </div>
    );
  } else if (state.kind === 'error') {
    recipes = (
      <div className="shop__empty" role="alert">
        <p className="display">The forge stays cold.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  } else {
    recipes = (
      <ul className="recipes">
        {state.value.recipes.map((r) => {
          const slot = slots[r.recipeId] ?? r.slots[0];
          const locked = r.blockers.find((b) => b.kind === 'level');
          const short = r.blockers.length > 0;
          const action = `craft:${r.recipeId}:${slot}`;
          return (
            <li key={r.recipeId} className={`recipe${locked ? ' recipe--locked' : ''}`}>
              <header className="recipe__head">
                <h3 className="display recipe__name">{r.name}</h3>
                <p className="caps recipe__tier">
                  {TIER_NAME[r.tier]} · level {r.level}
                </p>
              </header>
              <p className="recipe__desc">{r.description}</p>
              <ul className="recipe__cost" aria-label="Cost">
                {r.materials.map((m) => {
                  const have = held.get(m.materialId) ?? 0;
                  return (
                    <li key={m.materialId} className={have < m.quantity ? 'recipe__short' : ''}>
                      <MaterialStack material={materialView(m.materialId)} quantity={m.quantity} />
                      <span className="recipe__have">
                        {have}/{m.quantity}
                      </span>
                    </li>
                  );
                })}
                <li className={hero.gold < r.gold ? 'recipe__short' : ''}>
                  <span className="recipe__gold">
                    <Gold amount={r.gold} />
                  </span>
                  {r.townUpgrade ? (
                    <span className="recipe__town">
                      {r.townUpgrade.name}: was <Gold amount={r.townUpgrade.baseGold} />
                    </span>
                  ) : null}
                </li>
              </ul>
              {locked ? (
                <p className="recipe__blocked">Your hero needs level {r.level} for this work.</p>
              ) : (
                <>
                  <div className="recipe__slots" role="radiogroup" aria-label={`${r.name}: slot`}>
                    {r.slots.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={s === slot}
                        className="btn btn--small"
                        onClick={() => setSlots((prev) => ({ ...prev, [r.recipeId]: s }))}
                      >
                        {slotName(s)}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn--brass recipe__craft"
                    disabled={short || busy !== null || !slot}
                    aria-busy={busy === action}
                    onClick={() => slot && void craft(r, slot)}
                  >
                    {busy === action
                      ? 'Hammering…'
                      : short
                        ? 'Not enough materials'
                        : `Forge ${slot ? slotName(slot).toLowerCase() : ''}`}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="shop">
      <ShopHeader building="forge" title="The Forge">
        The smith breaks down what you no longer need, works your materials into new gear, and
        tempers the gear you keep: upgrades, reworked and honed affixes.
      </ShopHeader>
      <NoticeLine notice={notice} />

      <section className="shop__panel panel-iron" aria-labelledby="anvil-title">
        <header className="shop__panel-head">
          <h2 id="anvil-title" className="display shop__panel-title">
            The Anvil
          </h2>
          <p className="shop__panel-note">
            The smith decides each strike before you pay; asking again never changes it.
          </p>
        </header>
        {inventory.kind === 'ready' ? (
          <ForgeWork
            heroId={hero.id}
            gold={hero.gold}
            equipped={inventory.value.equipped}
            pack={items}
            materials={ready?.materials ?? []}
            onApplied={(r) => {
              updateCharacter(r.character);
              applyInventory(r.inventory);
              refreshMaterials();
              load();
            }}
            onNotice={setNotice}
          />
        ) : (
          <div className="shop__empty" role="status">
            <p className="display">Opening the pack…</p>
          </div>
        )}
      </section>

      <section className="shop__panel panel-iron" aria-labelledby="awaken-title">
        <header className="shop__panel-head">
          <h2 id="awaken-title" className="display shop__panel-title">
            The Banked Fire
          </h2>
          <p className="shop__panel-note">
            Awaken a finished item: its effect, or its set, burns a little stronger. Once, for good.
          </p>
        </header>
        {inventory.kind === 'ready' ? (
          <AwakenPanel
            heroId={hero.id}
            heroName={hero.name}
            classId={hero.classId}
            gold={hero.gold}
            equipped={inventory.value.equipped}
            pack={items}
            materials={ready?.materials ?? []}
            onApplied={(r) => {
              updateCharacter(r.character);
              applyInventory(r.inventory);
              refreshMaterials();
              load();
            }}
            onNotice={setNotice}
          />
        ) : (
          <div className="shop__empty" role="status">
            <p className="display">Opening the pack…</p>
          </div>
        )}
      </section>

      <section className="shop__panel panel-iron" aria-labelledby="engrave-title">
        <header className="shop__panel-head">
          <h2 id="engrave-title" className="display shop__panel-title">
            The Engraver
          </h2>
          <p className="shop__panel-note">
            Words cut into your gear, pressed in seal-wax or inlaid in silver. Only how it reads
            changes.
          </p>
        </header>
        {inventory.kind === 'ready' ? (
          <EngravePanel
            heroId={hero.id}
            equipped={inventory.value.equipped}
            pack={items}
            materials={ready?.materials ?? []}
            refresh={spent}
            onApplied={(r) => {
              updateCharacter(r.character);
              applyInventory(r.inventory);
              refreshMaterials();
              load();
            }}
            onNotice={setNotice}
          />
        ) : (
          <div className="shop__empty" role="status">
            <p className="display">Opening the pack…</p>
          </div>
        )}
      </section>

      <section className="shop__panel panel-iron" aria-labelledby="exchange-title">
        <header className="shop__panel-head">
          <h2 id="exchange-title" className="display shop__panel-title">
            The Seal and Silver Counter
          </h2>
          <p className="shop__panel-note">
            Spare Gravewarden’s Seals and Abbey silver, traded for keepsakes for your collection
            book. Each once.
          </p>
        </header>
        <ExchangePanel
          heroId={hero.id}
          banner={hero.appearance.banner}
          onBought={() => {
            refreshMaterials();
            setSpent((n) => n + 1);
            load();
          }}
          onNotice={setNotice}
        />
      </section>

      <div className="shop__cols">
        <section className="shop__panel panel-iron" aria-labelledby="craft-title">
          <header className="shop__panel-head">
            <h2 id="craft-title" className="display shop__panel-title">
              Commissions
            </h2>
            <p className="shop__panel-note">You pick the slot; the anvil picks the rest.</p>
          </header>
          {crafted ? (
            <div className="shop__inspect">
              <ItemTooltip item={crafted} caption="Fresh from the anvil" />
            </div>
          ) : null}
          {recipes}
        </section>

        <section className="shop__panel panel-iron" aria-labelledby="salvage-title">
          <header className="shop__panel-head">
            <h2 id="salvage-title" className="display shop__panel-title">
              Salvage
            </h2>
            <p className="shop__panel-note">
              Better gear gives more, and soul shards from rare up.
            </p>
          </header>
          {inventory.kind === 'ready' ? (
            <ItemPicker
              items={items}
              picked={new Set(pickedIds)}
              onChange={(next) => {
                setPicked(next);
                setConfirm(false);
              }}
              label="Items to salvage"
              emptyText="Your pack is empty. Bring something back from the fields."
            />
          ) : (
            <div className="shop__empty" role="status">
              <p className="display">Opening the pack…</p>
            </div>
          )}
          <footer className="shop__tally">
            {pickedIds.length === 0 ? (
              <p>Pick items to break down.</p>
            ) : (
              <div className="shop__yield" aria-label="You will get">
                {preview.materials.map((m) => (
                  <MaterialStack
                    key={m.materialId}
                    material={materialView(m.materialId)}
                    quantity={m.quantity}
                    sign="+"
                  />
                ))}
                <Gold amount={preview.gold} sign="+" />
              </div>
            )}
            <button
              type="button"
              className={`btn btn--brass${confirm ? ' shop__confirm' : ''}`}
              disabled={pickedIds.length === 0 || busy !== null}
              aria-busy={busy === 'salvage'}
              onClick={() => void salvage()}
            >
              {busy === 'salvage'
                ? 'Breaking down…'
                : confirm
                  ? `Salvage ${precious} rare or better?`
                  : `Salvage ${pickedIds.length || ''}`.trim()}
            </button>
            {confirm && busy === null ? (
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Keep them
              </button>
            ) : null}
          </footer>
        </section>
      </div>
    </div>
  );
}
