import type { ClassId } from '../classes.js';
import type { RarityId } from '../rarity.js';
import { createRng, hashSeed } from '../rng.js';
import { canClassUseItem, findItemBase } from '../items/bases.js';
import { generateItem, type GeneratedItem } from '../loot/generate.js';
import { getLootTable } from '../loot/config.js';
import { AREA_IDS, getArea, isAreaId, type AreaId } from '../world/areas.js';
import { DEFAULT_ECONOMY_CONFIG, type EconomyConfig } from './config.js';

/** Gold the merchant pays for an item (and the base of every other price). */
export function sellPrice(
  item: Pick<GeneratedItem, 'rarityId' | 'itemLevel'>,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): number {
  return Math.max(
    1,
    Math.round(
      (config.sellBase + config.sellPerItemLevel * item.itemLevel) *
        config.rarityMultiplier[item.rarityId],
    ),
  );
}

/** Gold the merchant asks for an item. */
export function buyPrice(
  item: Pick<GeneratedItem, 'rarityId' | 'itemLevel'>,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): number {
  return sellPrice(item, config) * config.merchant.buyMarkup;
}

/** The merchant's day: the UTC date of `now` (`YYYY-MM-DD`). Stock changes at UTC midnight. */
export function merchantDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** When the next day's stock arrives (the next UTC midnight). */
export function merchantRestockAt(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next;
}

export interface MerchantOffer {
  /** `<day>.<areaId>.<index>`: stable for the day; the buy request names it. */
  offerId: string;
  areaId: AreaId;
  item: GeneratedItem;
  price: number;
}

export interface MerchantStockParams {
  /** Seeds the stock together with the day, so each character sees its own stock. */
  characterId: string;
  classId: ClassId;
  day: string;
  /** Unlocked areas; each adds its own offers, independent of the others. */
  areaIds: readonly AreaId[];
}

/**
 * The day's stock for one area: `offersPerArea` basic items (common/uncommon) from the area's
 * loot table, usable by the class, at an item level within the area's enemy levels. Pure and
 * deterministic: the seed is `merchant:<characterId>:<day>:<areaId>`, so the stock a client sees
 * is exactly what the buy endpoint recomputes, and unlocking a new area mid-day only adds offers.
 */
export function areaStock(
  characterId: string,
  classId: ClassId,
  day: string,
  areaId: AreaId,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): MerchantOffer[] {
  const area = getArea(areaId);
  const table = getLootTable(area.lootTableId);
  const rng = createRng(hashSeed(`merchant:${characterId}:${day}:${areaId}`));
  const rarities = Object.entries(config.merchant.stockRarities) as [RarityId, number][];
  const offers: MerchantOffer[] = [];
  for (let index = 0; index < config.merchant.offersPerArea; index++) {
    const itemLevel = rng.int(area.minLevel, area.maxLevel);
    const rarityId = rng.weighted(rarities, ([, w]) => w)[0];
    const candidates = table.entries.filter((e) => {
      const base = findItemBase(e.baseId);
      return (
        base && e.weight > 0 && base.minItemLevel <= itemLevel && canClassUseItem(base, classId)
      );
    });
    const seed = rng.int(0, 0xffffffff);
    if (candidates.length === 0) continue;
    const baseId = rng.weighted(candidates, (e) => e.weight).baseId;
    const item = generateItem({ seed, itemLevel, baseId, rarityId, classId });
    if (!item) continue;
    offers.push({
      offerId: `${day}.${areaId}.${index}`,
      areaId,
      item,
      price: buyPrice(item, config),
    });
  }
  return offers;
}

/** The whole stock for the unlocked areas, in area order. */
export function merchantStock(
  params: MerchantStockParams,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): MerchantOffer[] {
  return AREA_IDS.filter((id) => params.areaIds.includes(id)).flatMap((areaId) =>
    areaStock(params.characterId, params.classId, params.day, areaId, config),
  );
}

/** Parses an offer id; `null` when it is malformed. */
export function parseOfferId(
  offerId: string,
): { day: string; areaId: AreaId; index: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})\.([A-Za-z]+)\.(\d{1,2})$/.exec(offerId);
  if (!m || !isAreaId(m[2])) return null;
  return { day: m[1]!, areaId: m[2], index: Number(m[3]) };
}
