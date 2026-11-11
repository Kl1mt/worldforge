import type { MaterialId } from '../world/materials.js';
import { findCosmetic, type CosmeticDefinition } from './catalogue.js';

/**
 * Ticket 6.11: the Forge's exchange and the engraver (docs/ECONOMY.md "Seal and silver sinks",
 * docs/COSMETICS.md "The exchange and engravings"). The two repeatable-or-finite sinks for the
 * Gravewarden's Seals left over after awakening and for Abbey silver once the Forgeward stands.
 *
 * **No power.** Nothing here is read by the combat, loot, scoring, PvP or trading rules (the
 * cosmetics import scan covers this file), an engraving is stored beside the item and never in
 * the item's rules, and an exchanged cosmetic is an ordinary collection-book entry. Prices are
 * materials earned in play, never money (GDD §13.3).
 */

/** What a sink costs: only the two materials it is for (no gold: gold already has its sinks). */
export type SinkPrice = Partial<
  Record<Extract<MaterialId, 'gravewardenSeal' | 'abbeySilver'>, number>
>;

export interface ExchangeOffer {
  /** A catalogue cosmetic whose source is `exchange`. */
  cosmeticId: string;
  price: SinkPrice;
}

/**
 * The exchange's offers, in the order the Forge shows them. Each is bought once per account (a
 * collection-book unlock; exactly once like every grant). Finite by design: the engraver below is
 * the repeatable sink.
 */
export const COSMETIC_EXCHANGE: readonly ExchangeOffer[] = [
  { cosmeticId: 'title-colour.seal-wax', price: { gravewardenSeal: 3 } },
  { cosmeticId: 'title-colour.abbey-silver', price: { abbeySilver: 25 } },
  { cosmeticId: 'banner.silvered-seal', price: { gravewardenSeal: 2, abbeySilver: 20 } },
  { cosmeticId: 'crest.abbey-silver', price: { abbeySilver: 30 } },
  { cosmeticId: 'crest.seal-wax', price: { gravewardenSeal: 4 } },
];

const OFFERS = new Map(COSMETIC_EXCHANGE.map((o) => [o.cosmeticId, o]));

export function exchangeOffer(cosmeticId: string): ExchangeOffer | undefined {
  return OFFERS.get(cosmeticId);
}

/** The catalogue entry of an offer (every offer has one; a test checks). */
export function exchangeCosmetic(offer: ExchangeOffer): CosmeticDefinition {
  return findCosmetic(offer.cosmeticId)!;
}

/**
 * An engraving's finish, the choice of material: pressed into the Gravewarden's seal-wax, or
 * inlaid in Abbey silver. Same words, a different colour in the tooltip.
 */
export type EngravingFinish = 'seal' | 'silver';

export const ENGRAVING_FINISHES: readonly EngravingFinish[] = ['seal', 'silver'];

/**
 * The engraver's prices per engraving (repeatable: every new engraving pays again, a re-engraving
 * included). Two Seals is an awakening's Seal share, so engraving a whole kit costs about what a
 * dedicated player has left over after awakening it (BALANCE.md "6.11").
 */
export const ENGRAVING_PRICES: Readonly<Record<EngravingFinish, SinkPrice>> = {
  seal: { gravewardenSeal: 2 },
  silver: { abbeySilver: 15 },
};

/**
 * The epithets the engraver cuts: a fixed list (no free text, so nothing to moderate). Ids are
 * stored on the item (`item_instances.engraving`), never renamed or reused.
 */
export interface EngravingDefinition {
  id: string;
  text: string;
}

export const ENGRAVINGS: readonly EngravingDefinition[] = [
  { id: 'ashbound', text: 'Ashbound' },
  { id: 'grave-kept', text: 'Grave-kept' },
  { id: 'unbowed', text: 'Unbowed' },
  { id: 'last-light', text: 'Last Light' },
  { id: 'oathworn', text: 'Oathworn' },
  { id: 'emberheart', text: 'Emberheart' },
  { id: 'drowned-vow', text: 'Drowned Vow' },
  { id: 'long-dusk', text: 'Of the Long Dusk' },
  { id: 'crypt-born', text: 'Crypt-born' },
  { id: 'warden-bane', text: 'Wardenbane' },
  { id: 'cinder-sworn', text: 'Cinder-sworn' },
  { id: 'nameless', text: 'Nameless' },
];

const ENGRAVING_BY_ID = new Map(ENGRAVINGS.map((e) => [e.id, e]));

export function findEngraving(id: string): EngravingDefinition | undefined {
  return ENGRAVING_BY_ID.get(id);
}

/** An item's stored engraving: `<finish>:<engraving id>`. */
export interface Engraving {
  finish: EngravingFinish;
  engravingId: string;
}

export function engravingKey(e: Engraving): string {
  return `${e.finish}:${e.engravingId}`;
}

/** The stored key read back; null for none or for a key that left the list. */
export function parseEngraving(key: string | null | undefined): Engraving | null {
  if (!key) return null;
  const [finish, engravingId] = key.split(':');
  if (!finish || !engravingId) return null;
  if (!(ENGRAVING_FINISHES as readonly string[]).includes(finish)) return null;
  if (!findEngraving(engravingId)) return null;
  return { finish: finish as EngravingFinish, engravingId };
}

/** Why an engraving is refused before anything is paid, or null. */
export function engravingRefusal(
  current: string | null | undefined,
  next: Engraving,
): 'unknown_engraving' | 'same_engraving' | null {
  if (!findEngraving(next.engravingId) || !ENGRAVING_FINISHES.includes(next.finish)) {
    return 'unknown_engraving';
  }
  return current === engravingKey(next) ? 'same_engraving' : null;
}
