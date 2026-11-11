import type { RarityId } from '@worldforge/game-core';
import { ItemFrame } from '../components/ItemFrame';
import type { ShimmerMode } from '../components/itemVariant';
import type { AwakenedView, VariantView } from '../game/items';

/**
 * Ticket A.12: the gallery's "Variants" section. One icon per rarity (and a set piece) in plain,
 * Void and Prismatic, drawn by the game's own `ItemFrame`. Fake item views, assets only: the
 * gallery only previews the treatment; in the game Void and Prismatic exist only on Legendary,
 * Mythic and set items (game-core decides).
 */
export const VARIANT_PREVIEW_ICONS: readonly { rarity: RarityId; icon: string; label: string }[] = [
  { rarity: 'common', icon: 'item.longsword', label: 'Common' },
  { rarity: 'uncommon', icon: 'item.bastard-sword', label: 'Uncommon' },
  { rarity: 'rare', icon: 'item.knights-plate', label: 'Rare' },
  { rarity: 'epic', icon: 'item.horn-recurve', label: 'Epic' },
  { rarity: 'legendary', icon: 'item.cinderforged-blade', label: 'Legendary' },
  { rarity: 'mythic', icon: 'item.crown-of-the-hollow-king', label: 'Mythic' },
  { rarity: 'legendary', icon: 'item.vigil-helm', label: 'Set piece' },
];

// `VariantView['id']` is game-core's variant id union; a string cast keeps this preview compiling
// before and after Prismatic joins it (ticket 6.4).
const fakeVariant = (id: string, name: string): VariantView => ({
  id: id as VariantView['id'],
  name,
  implicitBonus: 0,
  effectBonus: 0,
  affixBonus: 0,
});

/** Ticket 6.5b: the awakened mark, on its own and on each variant. */
const AWAKE: AwakenedView = { bonus: 0.1, kind: 'effect', at: null };

export const VARIANT_PREVIEW_ROWS: readonly {
  key: string;
  label: string;
  variant: VariantView | null;
  awakened?: AwakenedView;
}[] = [
  { key: 'plain', label: 'Plain', variant: null },
  { key: 'void', label: 'Void', variant: fakeVariant('void', 'Void') },
  { key: 'prismatic', label: 'Prismatic', variant: fakeVariant('prismatic', 'Prismatic') },
  { key: 'awakened', label: 'Awakened', variant: null, awakened: AWAKE },
  {
    key: 'void-awakened',
    label: 'Void, awakened',
    variant: fakeVariant('void', 'Void'),
    awakened: AWAKE,
  },
  {
    key: 'prismatic-awakened',
    label: 'Prismatic, awakened',
    variant: fakeVariant('prismatic', 'Prismatic'),
    awakened: AWAKE,
  },
];

/**
 * Only Legendary and Mythic items (set pieces are Legendary) carry a variant or awaken in the game
 * (game-core `activeVariant`, `docs/AWAKENING.md`); other rarities show a dash, not a fake look.
 */
export function carriesVariant(rarity: RarityId): boolean {
  return rarity === 'legendary' || rarity === 'mythic';
}

export function VariantPreview({ scale, shimmer }: { scale: number; shimmer: ShimmerMode }) {
  return (
    <section className="anim-gallery__group" aria-label="Variants">
      <h2 className="rule-heading anim-gallery__title">
        Variants{' '}
        <span className="anim-gallery__note">
          item frames, plain, Void and Prismatic, and awakened (☼); in the game only Legendary,
          Mythic and set items carry a variant, and only +10 ones at item level 23+ awaken
        </span>
      </h2>
      <table className="anim-gallery__variants">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Variant</span>
            </th>
            {VARIANT_PREVIEW_ICONS.map((c) => (
              <th key={c.label} scope="col" className="caps">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {VARIANT_PREVIEW_ROWS.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="caps">
                {row.label}
              </th>
              {VARIANT_PREVIEW_ICONS.map((c) =>
                row.key !== 'plain' && !carriesVariant(c.rarity) ? (
                  <td key={c.label} className="anim-gallery__na">
                    <span aria-hidden="true">—</span>
                    <span className="visually-hidden">Not in the game</span>
                  </td>
                ) : (
                  <td key={c.label}>
                    <ItemFrame
                      item={{
                        icon: c.icon,
                        name: c.icon.replace(/^item\./, ''),
                        rarity: c.rarity,
                        variant: row.variant,
                        ...(row.awakened ? { awakened: row.awakened, upgradeLevel: 10 } : {}),
                      }}
                      scale={scale}
                      context={`${c.label}, ${row.label}`}
                      shimmer={shimmer}
                    />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
