import { GUILD_REFUSALS, type GuildRefusal, type GuildStanding } from '../social/guilds.js';
import type { MaterialId } from '../world/materials.js';

/**
 * Guild halls (ticket 8.4, docs/GUILD_HALLS.md). A guild's hall shows cosmetic upgrades bought from
 * a shared treasury its members fund with gold and materials. **Cosmetic only:** an upgrade has no
 * stats, no drop odds and no power (a test checks every entry's keys), and nothing in the combat,
 * loot, farming, dungeon, economy, trading, scoring or PvP rules reads this module (an import scan).
 *
 * Never rename or reuse an upgrade id: `guild_hall_upgrades` keeps it.
 */

/**
 * - `hallBanner`: the banners hung in the hall (and beside the guild's name on its page and roll);
 * - `crestFrame`: the frame around the guild's emblem;
 * - `backdrop`: the tint of the hall's backdrop;
 * - `titleColour`: the colour of the guild's name.
 */
export const GUILD_HALL_KINDS = ['hallBanner', 'crestFrame', 'backdrop', 'titleColour'] as const;
export type GuildHallKind = (typeof GUILD_HALL_KINDS)[number];

/** What the treasury takes: gold and these materials. */
export const TREASURY_MATERIALS = [
  'timber',
  'rawHide',
  'ironOre',
  'soulShard',
  'abbeySilver',
] as const satisfies readonly MaterialId[];
export type TreasuryMaterial = (typeof TREASURY_MATERIALS)[number];
export type TreasuryResource = 'gold' | TreasuryMaterial;
export const TREASURY_RESOURCES: readonly TreasuryResource[] = ['gold', ...TREASURY_MATERIALS];
export const isTreasuryResource = (v: unknown): v is TreasuryResource =>
  typeof v === 'string' && (TREASURY_RESOURCES as readonly string[]).includes(v);

export type TreasuryAmounts = Partial<Record<TreasuryResource, number>>;

export interface GuildHallUpgrade {
  /** `<kind prefix>.<kebab-case name>`. */
  id: string;
  kind: GuildHallKind;
  name: string;
  description: string;
  /** Paid from the treasury, once per guild. */
  price: { gold: number; materials: Partial<Record<TreasuryMaterial, number>> };
}

export const GUILD_HALL_UPGRADES: readonly GuildHallUpgrade[] = [
  {
    id: 'hall-banner.iron-drapes',
    kind: 'hallBanner',
    name: 'Ironbound drapes',
    description: 'Grey wool drapes on iron rings, hung either side of the hearth.',
    price: { gold: 8_000, materials: { ironOre: 80 } },
  },
  {
    id: 'hall-banner.ember-hangings',
    kind: 'hallBanner',
    name: 'Ember hangings',
    description: 'Long hangings in the Watch’s ember red, stitched with the guild’s charge.',
    price: { gold: 20_000, materials: { ironOre: 150, soulShard: 40 } },
  },
  {
    id: 'hall-banner.pale-silks',
    kind: 'hallBanner',
    name: 'Pale silks of the Reach',
    description: 'Bleached silks from beyond the Hollow, that hang still in any draught.',
    price: { gold: 45_000, materials: { soulShard: 120, abbeySilver: 30 } },
  },
  {
    id: 'crest-frame.iron-rim',
    kind: 'crestFrame',
    name: 'Iron rim',
    description: 'A plain riveted rim around the guild’s shield.',
    price: { gold: 6_000, materials: { ironOre: 60 } },
  },
  {
    id: 'crest-frame.bone-ring',
    kind: 'crestFrame',
    name: 'Bone ring',
    description: 'A ring of carved bone, as the old crypt-wardens wore.',
    price: { gold: 18_000, materials: { soulShard: 80 } },
  },
  {
    id: 'crest-frame.gilt-wreath',
    kind: 'crestFrame',
    name: 'Gilt wreath',
    description: 'A wreath of gilt leaves around the shield.',
    price: { gold: 50_000, materials: { abbeySilver: 40 } },
  },
  {
    id: 'backdrop.hearth-glow',
    kind: 'backdrop',
    name: 'Hearth glow',
    description: 'A warm fire kept burning in the hall all night.',
    price: { gold: 10_000, materials: { timber: 120 } },
  },
  {
    id: 'backdrop.moonlit-stone',
    kind: 'backdrop',
    name: 'Moonlit stone',
    description: 'Tall windows cut in the east wall: the hall in cold blue moonlight.',
    price: { gold: 15_000, materials: { rawHide: 100 } },
  },
  {
    id: 'backdrop.hollow-lantern',
    kind: 'backdrop',
    name: 'Hollow lantern-light',
    description: 'Lanterns that burn the green-blue of the deep, hung from the rafters.',
    price: { gold: 30_000, materials: { soulShard: 150 } },
  },
  {
    id: 'guild-colour.forge-gold',
    kind: 'titleColour',
    name: 'Forge-gold',
    description: 'The guild’s name in the gold of metal fresh from the forge.',
    price: { gold: 12_000, materials: {} },
  },
  {
    id: 'guild-colour.grave-green',
    kind: 'titleColour',
    name: 'Grave-moss green',
    description: 'The guild’s name in the green of moss on old graves.',
    price: { gold: 12_000, materials: {} },
  },
  {
    id: 'guild-colour.blood-wine',
    kind: 'titleColour',
    name: 'Blood-wine',
    description: 'The guild’s name in a deep wine red.',
    price: { gold: 12_000, materials: {} },
  },
];

const BY_ID = new Map(GUILD_HALL_UPGRADES.map((u) => [u.id, u]));
export const findGuildHallUpgrade = (id: string) => BY_ID.get(id);

/** The whole hall's price per resource (the caps are shares of it). */
export function hallTotalPrice(): Record<TreasuryResource, number> {
  const out = Object.fromEntries(TREASURY_RESOURCES.map((r) => [r, 0])) as Record<
    TreasuryResource,
    number
  >;
  for (const u of GUILD_HALL_UPGRADES) {
    out.gold += u.price.gold;
    for (const [m, n] of Object.entries(u.price.materials) as [TreasuryMaterial, number][])
      out[m] += n;
  }
  return out;
}

/**
 * The anti-monopoly cap (B.3's model): one account (all its heroes) gives at most `capShare` of the
 * whole hall's price in each resource per contribution window (the game-clock UTC day), so one
 * rich member needs at least ten days to fund the hall alone, and ten members can do it in one.
 */
export const GUILD_TREASURY_CONFIG = { capShare: 0.1 } as const;

export function treasuryCap(resource: TreasuryResource): number {
  const total = hallTotalPrice()[resource];
  return total > 0 ? Math.max(1, Math.ceil(total * GUILD_TREASURY_CONFIG.capShare)) : 0;
}

/**
 * What the treasury may still hold of each resource: the price of the upgrades not bought yet,
 * less what it holds (no over-fill: nobody gives toward nothing).
 */
export function treasuryRoom(
  owned: ReadonlySet<string>,
  held: TreasuryAmounts,
): Record<TreasuryResource, number> {
  const room = Object.fromEntries(TREASURY_RESOURCES.map((r) => [r, 0])) as Record<
    TreasuryResource,
    number
  >;
  for (const u of GUILD_HALL_UPGRADES) {
    if (owned.has(u.id)) continue;
    room.gold += u.price.gold;
    for (const [m, n] of Object.entries(u.price.materials) as [TreasuryMaterial, number][])
      room[m] += n;
  }
  for (const r of TREASURY_RESOURCES) room[r] = Math.max(0, room[r] - (held[r] ?? 0));
  return room;
}

export type TreasuryLimit = 'room' | 'cap';

export interface TreasuryPlan {
  accepted: TreasuryAmounts;
  limited: Partial<Record<TreasuryResource, TreasuryLimit>>;
}

/**
 * How much of an offer the treasury takes (pure; the server calls it under the guild's lock with
 * the holdings and the account's window sums read under it): never more than the hall still needs
 * or the account may still give today. The rest stays with the hero.
 */
export function planTreasuryGift(
  owned: ReadonlySet<string>,
  held: TreasuryAmounts,
  givenToday: TreasuryAmounts,
  offer: TreasuryAmounts,
): TreasuryPlan {
  const room = treasuryRoom(owned, held);
  const accepted: TreasuryAmounts = {};
  const limited: TreasuryPlan['limited'] = {};
  for (const [resource, amount] of Object.entries(offer) as [TreasuryResource, number][]) {
    if (!isTreasuryResource(resource)) throw new RangeError(`Not a treasury resource: ${resource}`);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new RangeError(`Invalid amount of ${resource}: ${amount}`);
    }
    const capLeft = Math.max(0, treasuryCap(resource) - (givenToday[resource] ?? 0));
    const take = Math.min(amount, room[resource], capLeft);
    if (take < amount) limited[resource] = room[resource] <= capLeft ? 'room' : 'cap';
    if (take > 0) accepted[resource] = take;
  }
  return { accepted, limited };
}

/** Whether the treasury holds an upgrade's price. */
export function canAfford(u: GuildHallUpgrade, held: TreasuryAmounts): boolean {
  if ((held.gold ?? 0) < u.price.gold) return false;
  return (Object.entries(u.price.materials) as [TreasuryMaterial, number][]).every(
    ([m, n]) => (held[m] ?? 0) >= n,
  );
}

/** The words shown before every gift (and returned by the API): nothing is ever given back. */
export const TREASURY_NO_REFUND_NOTICE =
  'Gifts to the guild treasury are never given back: not if you leave the guild, are removed from it, or the guild is disbanded. A disbanded guild’s treasury is lost.';

/**
 * Who may do what in the guild hall (tested role × action through the API).
 *
 * | action ↓ / standing → | leader | officer | member | not a member |
 * |---|---|---|---|---|
 * | view the hall | ✓ | ✓ | ✓ | 404 not_in_guild |
 * | give to the treasury | ✓ | ✓ | ✓ | 404 |
 * | buy an upgrade | ✓ | ✓ | 403 guild_forbidden | 404 |
 * | hang (display) an upgrade | ✓ | ✓ | 403 | 404 |
 */
export const GUILD_HALL_ACTIONS = ['view', 'contribute', 'buy', 'display'] as const;
export type GuildHallAction = (typeof GUILD_HALL_ACTIONS)[number];

const MEMBERS: readonly GuildStanding[] = ['leader', 'officer', 'member'];
const OFFICERS: readonly GuildStanding[] = ['leader', 'officer'];
const ALLOWED: Record<GuildHallAction, readonly GuildStanding[]> = {
  view: MEMBERS,
  contribute: MEMBERS,
  buy: OFFICERS,
  display: OFFICERS,
};

export const GUILD_HALL_REFUSALS = {
  alreadyOwned: { status: 409, code: 'already_owned', message: 'The hall has that already.' },
  cannotAfford: {
    status: 409,
    code: 'treasury_short',
    message: 'The treasury does not hold enough for that yet.',
  },
  notOwned: { status: 422, code: 'not_owned', message: 'The hall does not have that yet.' },
  unknown: { status: 422, code: 'unknown_upgrade', message: 'There is no such hall upgrade.' },
  wrongKind: { status: 422, code: 'wrong_kind', message: 'That does not go there.' },
  noRefundUnacknowledged: {
    status: 422,
    code: 'no_refund_unacknowledged',
    message: TREASURY_NO_REFUND_NOTICE,
  },
  nothingTaken: {
    status: 409,
    code: 'treasury_capped',
    message: 'The treasury can take none of that today.',
  },
} as const satisfies Record<string, GuildRefusal>;

export function guildHallDecision(
  standing: GuildStanding,
  action: GuildHallAction,
): 'allowed' | GuildRefusal {
  if (standing === 'none') return GUILD_REFUSALS.notInGuild;
  return ALLOWED[action].includes(standing) ? 'allowed' : GUILD_REFUSALS.forbidden;
}

/** The hall's look (one shown upgrade per kind; null = plain). */
export type GuildHallDisplay = Record<GuildHallKind, string | null>;
export const PLAIN_HALL: GuildHallDisplay = {
  hallBanner: null,
  crestFrame: null,
  backdrop: null,
  titleColour: null,
};

/** Why a display change is refused, or null. */
export function hallDisplayProblem(
  kind: GuildHallKind,
  id: string | null,
  owned: ReadonlySet<string>,
): 'unknown' | 'wrong_kind' | 'not_owned' | null {
  if (id === null) return null;
  const u = findGuildHallUpgrade(id);
  if (!u) return 'unknown';
  if (u.kind !== kind) return 'wrong_kind';
  return owned.has(id) ? null : 'not_owned';
}
