import { useId, useMemo, useState } from 'react';
import { DEFAULT_LOOT_CONFIG, RARITIES, findItemBase, type RarityId } from '@worldforge/game-core';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { toItemView, type ItemView } from '../game/items';
import {
  toolsApi,
  type AccountFile,
  type AdminItem,
  type GrantSpec,
  type HeroFile,
  type PreviewItem,
} from '../admin/tools-api';
import {
  LOCATION_LABEL,
  basesBySlot,
  describeToolFailure,
  groupByLocation,
  itemProblems,
  removeBlockedText,
  type CheatAccess,
} from '../admin/tools-view';
import { slotName } from '../game/items';
import { answered, boardsNote, SmallField, useWrit } from './AdminToolKit';

/**
 * Ticket D.4: items in the inspector. The ledger of a hero's (or the shelf's) items by location,
 * each with its tooltip and a Remove that opens the typed-confirmation writ; and the grant bench
 * (base, rarity, item level, variant, upgrade → server preview → reroll → grant the same seed).
 */

const RARITY_NAME = new Map(RARITIES.map((r) => [r.id, r.name]));
const rarityName = (id: RarityId) => RARITY_NAME.get(id) ?? id;

function itemLine(view: ItemView): string {
  return `${view.variant ? `${view.variant.name} ` : ''}${view.name}${view.upgradeLevel > 0 ? ` +${view.upgradeLevel}` : ''} (${rarityName(view.rarity)}, item level ${view.itemLevel})`;
}

/** A hero's items, or the account shelf's, grouped by where they sit. */
export function ItemLedger({
  account,
  items,
  heroes,
  shelf,
  label,
}: {
  account: AccountFile;
  items: AdminItem[];
  /** Every hero of the account (names for the writ and shelf rows). */
  heroes: HeroFile[];
  /** Shelf items: the typed confirmation is the handle. */
  shelf?: boolean;
  label: string;
}) {
  const groups = groupByLocation(items);
  // Set tooltips count this hero's pieces (not the admin's own active hero's).
  const setPack = useMemo(
    () => ({
      equipped: items.filter((i) => i.location === 'equipped').map((i) => toItemView(i)),
      items: items.filter((i) => i.location === 'pack').map((i) => toItemView(i)),
    }),
    [items],
  );
  if (groups.length === 0) {
    return <p className="adt-none">{shelf ? 'The shelf holds no items.' : 'No items at all.'}</p>;
  }
  return (
    <div className="adt-itemgroups" aria-label={label} role="group">
      {groups.map((g) => (
        <section key={g.location} className="adt-itemgroup">
          <h4 className="caps adt-itemgroup__title">
            {LOCATION_LABEL[g.location]} <span className="adt-dim">· {g.items.length}</span>
          </h4>
          <ul className="adt-items">
            {g.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                account={account}
                heroName={heroes.find((h) => h.id === item.characterId)?.name ?? 'a hero'}
                shelf={Boolean(shelf)}
                setPack={setPack}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ItemRow({
  item,
  account,
  heroName,
  shelf,
  setPack,
}: {
  item: AdminItem;
  account: AccountFile;
  heroName: string;
  shelf: boolean;
  setPack: { equipped: ItemView[]; items: ItemView[] };
}) {
  const openWrit = useWrit();
  const view = useMemo(() => toItemView(item), [item]);
  const blocked = removeBlockedText(item);
  const where = shelf
    ? `the account shelf (placed by ${heroName})`
    : `${heroName}’s ${LOCATION_LABEL[item.location].toLowerCase()}`;
  const remove = () =>
    openWrit({
      caps: `Support · ${shelf ? `@${account.handle}` : heroName}`,
      title: `Remove ${view.name}`,
      destructive: true,
      changes: [
        <>
          <strong className={`rarity-${view.rarity} adt-rarity`}>{itemLine(view)}</strong> is
          removed from {where}.
        </>,
        item.location === 'equipped'
          ? `It is taken off first, so ${heroName}’s stats drop.`
          : 'Nothing else on the hero changes.',
        'It is gone for good: no salvage, no gold, no undo.',
      ],
      detail: <ItemTooltip item={view} />,
      confirm: shelf
        ? { expected: account.handle, what: 'the account handle' }
        : { expected: heroName, what: 'the hero’s name' },
      action: 'Remove the item',
      busy: 'Removing…',
      run: (key, reason, confirm) =>
        answered(
          toolsApi.removeItem(account.handle, item.id, key, { confirm, reason }),
          () => `${view.name} was removed from ${where}.`,
        ),
    });
  return (
    <li className="adt-item">
      <ItemFrame item={view} scale={1} />
      <div className="adt-item__text">
        <p className={`adt-item__name rarity-${view.rarity}`}>
          {view.variant ? `${view.variant.name} ` : ''}
          {view.name}
          {view.upgradeLevel > 0 ? ` +${view.upgradeLevel}` : ''}
        </p>
        <p className="adt-dim">
          {rarityName(view.rarity)} · {view.slot ? slotName(view.slot) : 'Unknown base'} · item
          level {view.itemLevel}
          {view.equippedSlot ? ` · worn: ${slotName(view.equippedSlot)}` : ''}
          {view.locked ? ' · locked' : ''}
        </p>
        <details className="adt-item__more">
          <summary>Details</summary>
          <ItemTooltip item={view} setPack={setPack} />
        </details>
      </div>
      <div className="adt-item__act">
        <button
          type="button"
          className="btn btn--small"
          onClick={remove}
          disabled={blocked !== null}
          aria-describedby={blocked ? `${item.id}-blocked` : undefined}
        >
          Remove…
        </button>
        {blocked ? (
          <p id={`${item.id}-blocked`} className="adt-item__blocked">
            {blocked}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** The display model of a preview (it has no row yet). */
export function previewView(p: PreviewItem): ItemView {
  return toItemView({
    id: `preview-${p.seed}`,
    baseId: p.baseId,
    rarityId: p.rarityId,
    itemLevel: p.itemLevel,
    affixes: p.affixes,
    equippedSlot: null,
    source: 'admin',
    createdAt: new Date(0).toISOString(),
    effectId: p.effectId ?? null,
    effectRoll: p.effectRoll ?? null,
    setId: p.setId ?? null,
    mythicId: p.mythicId ?? null,
    upgradeLevel: p.upgradeLevel,
    variant: p.variant ?? null,
  });
}

type Preview =
  | { kind: 'none' }
  | { kind: 'busy' }
  | { kind: 'ready'; seed: number; item: PreviewItem; view: ItemView; spec: GrantSpec }
  | { kind: 'error'; message: string; problems: string[] };

const BASE_GROUPS = basesBySlot();
const MAX_ITEM_LEVEL = DEFAULT_LOOT_CONFIG.maxItemLevel;

/** Grant an item: build it, preview it on the server, reroll, then grant that exact roll. */
export function GrantItemTool({
  account,
  hero,
  cheat,
}: {
  account: AccountFile;
  hero: HeroFile;
  cheat: CheatAccess;
}) {
  const ids = useId();
  const openWrit = useWrit();
  const [baseId, setBaseId] = useState(BASE_GROUPS[0]?.bases[0]?.id ?? '');
  const [rarityId, setRarityId] = useState<RarityId>('rare');
  const [itemLevel, setItemLevel] = useState(String(Math.min(hero.level, MAX_ITEM_LEVEL)));
  const [variant, setVariant] = useState<'void' | ''>('');
  const [upgrade, setUpgrade] = useState('0');
  const [preview, setPreview] = useState<Preview>({ kind: 'none' });
  const blocked = cheat === 'blocked';

  const level = Number(itemLevel);
  const levelOk = /^\d{1,2}$/.test(itemLevel) && level >= 1 && level <= MAX_ITEM_LEVEL;
  const up = Number(upgrade);
  const upOk = /^\d{1,2}$/.test(upgrade) && up >= 0 && up <= 10;
  const base = findItemBase(baseId);
  const spec: GrantSpec | null =
    levelOk && upOk && base
      ? { baseId, rarityId, itemLevel: level, variant: variant || null, upgradeLevel: up }
      : null;
  const stale = (s: GrantSpec) => JSON.stringify(s) !== JSON.stringify(spec);

  // Any change to the recipe drops the old preview: a grant only ever sends what was shown.
  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview({ kind: 'none' });
    };

  // Preview and Reroll both ask for a fresh roll (no seed); Grant sends the seed shown.
  const roll = async () => {
    if (!spec) return;
    setPreview({ kind: 'busy' });
    const res = await toolsApi.previewItem(account.handle, hero.id, spec);
    if (!res.ok) {
      setPreview({
        kind: 'error',
        message: describeToolFailure(res.error),
        problems: itemProblems(res.error),
      });
      return;
    }
    setPreview({
      kind: 'ready',
      seed: res.value.seed,
      item: res.value.item,
      view: previewView(res.value.item),
      spec,
    });
  };

  const grant = () => {
    if (preview.kind !== 'ready' || stale(preview.spec)) return;
    const { view, seed, spec: s } = preview;
    openWrit({
      caps: `Testing · ${hero.name}`,
      title: `Grant ${view.name}`,
      changes: [
        <>
          <strong className={`rarity-${view.rarity} adt-rarity`}>{itemLine(view)}</strong> is
          created in {hero.name}’s pack, exactly as previewed (roll {seed}).
        </>,
        'Refused if the pack is full.',
      ],
      detail: <ItemTooltip item={view} />,
      warning:
        cheat === 'own'
          ? 'This is your own account, not a test account: the item can show on public boards.'
          : undefined,
      action: 'Grant the item',
      busy: 'Granting…',
      run: (key, reason) =>
        answered(
          toolsApi.grantItem(account.handle, hero.id, key, { ...s, seed, reason }),
          (a) => `${view.name} is in ${hero.name}’s pack.${boardsNote(a)}`,
        ),
    });
  };

  return (
    <section className="adt-tool adt-tool--testing adt-grant" aria-labelledby={`${ids}-t`}>
      <p className="caps adt-tool__kind">Testing</p>
      <h4 id={`${ids}-t`} className="adt-tool__title">
        Grant an item
      </h4>
      <fieldset className="adt-tool__body adt-grant__form" disabled={blocked}>
        <SmallField label="Base" htmlFor={`${ids}-base`}>
          <select
            id={`${ids}-base`}
            className="field__input"
            value={baseId}
            onChange={(e) => change(setBaseId)(e.target.value)}
          >
            {BASE_GROUPS.map((g) => (
              <optgroup key={g.slot} label={slotName(g.slot)}>
                {g.bases.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.tag ? ` — ${b.tag}` : ''}
                    {b.minItemLevel > 1 ? ` (item level ${b.minItemLevel}+)` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </SmallField>
        <SmallField label="Rarity" htmlFor={`${ids}-rarity`}>
          <select
            id={`${ids}-rarity`}
            className="field__input"
            value={rarityId}
            onChange={(e) => change(setRarityId)(e.target.value as RarityId)}
          >
            {RARITIES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </SmallField>
        <SmallField
          label="Item level"
          htmlFor={`${ids}-ilvl`}
          invalid={!levelOk}
          hint={`1–${MAX_ITEM_LEVEL}`}
        >
          <input
            id={`${ids}-ilvl`}
            className="field__input"
            inputMode="numeric"
            value={itemLevel}
            onChange={(e) => change(setItemLevel)(e.target.value.trim())}
            aria-invalid={!levelOk}
          />
        </SmallField>
        <SmallField
          label="Variant"
          htmlFor={`${ids}-variant`}
          hint="Void applies to Legendary and Mythic"
        >
          <select
            id={`${ids}-variant`}
            className="field__input"
            value={variant}
            onChange={(e) => change(setVariant)(e.target.value as 'void' | '')}
          >
            <option value="">None</option>
            <option value="void">Void</option>
          </select>
        </SmallField>
        <SmallField label="Upgrade" htmlFor={`${ids}-up`} invalid={!upOk} hint="0–10">
          <input
            id={`${ids}-up`}
            className="field__input"
            inputMode="numeric"
            value={upgrade}
            onChange={(e) => change(setUpgrade)(e.target.value.trim())}
            aria-invalid={!upOk}
          />
        </SmallField>
        <div className="adt-tool__row">
          <button
            type="button"
            className="btn btn--small"
            disabled={!spec || preview.kind === 'busy'}
            onClick={() => roll()}
          >
            {preview.kind === 'busy' ? 'Rolling…' : 'Preview'}
          </button>
        </div>
      </fieldset>
      {blocked ? (
        <p className="adt-tool__blocked">Test accounts and your own account only.</p>
      ) : null}

      <div className="adt-grant__preview" aria-live="polite">
        {preview.kind === 'none' ? (
          <p className="adt-dim">
            Preview rolls the item on the server. Grant then creates exactly that roll.
          </p>
        ) : null}
        {preview.kind === 'error' ? (
          <div className="gate__alert strong__alert" role="alert">
            <p>{preview.problems.length > 0 ? 'This item can’t exist:' : preview.message}</p>
            {preview.problems.length > 0 ? (
              <ul className="adt-problems">
                {preview.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {preview.kind === 'ready' ? (
          <>
            <div className="adt-grant__card">
              <ItemFrame item={preview.view} scale={2} />
              <ItemTooltip item={preview.view} caption={`Preview · roll ${preview.seed}`} />
            </div>
            <div className="adt-tool__row">
              <button
                type="button"
                className="btn btn--small"
                disabled={blocked}
                onClick={() => roll()}
              >
                Reroll
              </button>
              <button
                type="button"
                className="btn btn--small btn--brass"
                disabled={blocked}
                onClick={grant}
              >
                Grant…
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
