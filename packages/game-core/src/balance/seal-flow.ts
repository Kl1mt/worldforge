/**
 * Ticket 6.11: the Seal and Abbey silver flow of a season (docs/BALANCE.md "6.11"). A day-by-day
 * model of expected values at the realistic cadence (B.5): from the day a hero first beats the
 * Forge Tyrant it gains `embersPerDay` Tyrant's Embers and `sealsPerDay` Gravewarden's Seals
 * (crypt hoards) plus `guildSealsPerWeek`, and awakens a piece whenever it can pay for one (only
 * Embers and Seals gate it: B.5 item 8, gold takes 4–9 hours). With `sinks`, the player also spends
 * on the exchange and the engraver, **only the Seals above its reserve** (two per piece still to
 * awaken), the policy the Forge's warning suggests; engravings are capped at `engravingsWanted`.
 *
 * Takes the prices as input (balance code never imports the cosmetics module; the import scan).
 */

export interface SealFlowPrices {
  /** Seals per awakening (`DEFAULT_AWAKENING_SETTINGS.cost.gravewardenSeal`). */
  awakenSeals: number;
  awakenEmbers: number;
  /** The exchange's offers (one-time each): Seals and silver. */
  exchange: readonly { seals: number; silver: number }[];
  /** One engraving, by finish. */
  engraveSeals: number;
  engraveSilver: number;
}

export interface SealFlowInput {
  days: number;
  sealsPerDay: number;
  guildSealsPerWeek: number;
  embersPerDay: number;
  /** Kit pieces to awaken (8; the warrior 9). */
  pieces: number;
  /** Abbey silver held on the first day (gathered earlier; none comes in at the endgame). */
  silverStock: number;
  prices: SealFlowPrices;
  /** Spend on the sinks (false = before 6.11). */
  sinks: boolean;
  /** How many engravings the player wants over the season (each kit piece once by default). */
  engravingsWanted?: number;
}

export interface SealFlowResult {
  /** Day the last piece is awakened (1-based), or null when the season ends first. */
  kitDay: number | null;
  /** Spare Seals at the end of the day the kit is done, after that day's sinks (null: not done). */
  spareAtKit: number | null;
  /** Seals spent on the sinks by then. */
  sinkSealsAtKit: number | null;
  sealsIn: number;
  sealsToAwakening: number;
  sealsToSinks: number;
  silverToSinks: number;
  exchangeBought: number;
  engravings: number;
  /** At the season's end. */
  sealsLeft: number;
  silverLeft: number;
}

export function sealFlow(input: SealFlowInput): SealFlowResult {
  const p = input.prices;
  const wanted = input.engravingsWanted ?? input.pieces;
  let seals = 0;
  let embers = 0;
  let silver = input.silverStock;
  let awakened = 0;
  let kitDay: number | null = null;
  let spareAtKit: number | null = null;
  let sealsIn = 0;
  let toAwaken = 0;
  let toSinks = 0;
  let silverOut = 0;
  let engravings = 0;
  let sinkSealsAtKit: number | null = null;
  const bought = new Set<number>();
  const eps = 1e-9;
  for (let day = 1; day <= input.days; day += 1) {
    const gained = input.sealsPerDay + input.guildSealsPerWeek / 7;
    seals += gained;
    sealsIn += gained;
    embers += input.embersPerDay;
    while (
      awakened < input.pieces &&
      embers + eps >= p.awakenEmbers &&
      seals + eps >= p.awakenSeals
    ) {
      embers -= p.awakenEmbers;
      seals -= p.awakenSeals;
      toAwaken += p.awakenSeals;
      awakened += 1;
      if (awakened === input.pieces) {
        kitDay = day;
        spareAtKit = seals;
        sinkSealsAtKit = toSinks;
      }
    }
    if (!input.sinks) continue;
    const reserve = () => (input.pieces - awakened) * p.awakenSeals;
    const spareSeals = () => seals - reserve();
    // The exchange first (each offer once), then engravings: Seal-pressed while Seals are spare,
    // silver-inlaid only with silver beyond what the unbought offers still need; the reserve stays
    // whole either way.
    p.exchange.forEach((o, i) => {
      if (bought.has(i)) return;
      if (spareSeals() + eps >= o.seals && silver + eps >= o.silver) {
        seals -= o.seals;
        silver -= o.silver;
        toSinks += o.seals;
        silverOut += o.silver;
        bought.add(i);
      }
    });
    while (engravings < wanted) {
      if (spareSeals() + eps >= p.engraveSeals) {
        seals -= p.engraveSeals;
        toSinks += p.engraveSeals;
      } else if (
        silver + eps >=
        p.engraveSilver + p.exchange.reduce((n, o, i) => n + (bought.has(i) ? 0 : o.silver), 0)
      ) {
        silver -= p.engraveSilver;
        silverOut += p.engraveSilver;
      } else break;
      engravings += 1;
    }
    if (kitDay === day) {
      spareAtKit = seals;
      sinkSealsAtKit = toSinks;
    }
  }
  return {
    kitDay,
    spareAtKit,
    sinkSealsAtKit,
    sealsIn,
    sealsToAwakening: toAwaken,
    sealsToSinks: toSinks,
    silverToSinks: silverOut,
    exchangeBought: bought.size,
    engravings,
    sealsLeft: seals,
    silverLeft: silver,
  };
}
