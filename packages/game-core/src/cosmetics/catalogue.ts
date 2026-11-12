import { PRESTIGE_TIER_IDS, type PrestigeTier } from '../scoring/prestige.js';

/**
 * The cosmetic catalogue (ticket 6.6 started it, ticket 6.8's collection book completes it;
 * docs/COSMETICS.md). Every cosmetic has an id, a kind, a name, a description and the one place it
 * is earned. **Cosmetics carry no stats** (GDD §13.3): a definition
 * has no price and no numbers (a later real-money shop, ROADMAP 8.8, would price looks outside it) (ticket 6.11's exchange prices, in materials earned in play, live in
 * `exchange.ts`), nothing in the combat, loot, farming, dungeon, economy, trading, scoring
 * or PvP rules reads this module (an import scan in `cosmetics.test.ts`), and the no-effects hashes
 * and 5.1 scores are unchanged by them. Account-bound: never traded, never mailed.
 *
 * Adding one: append a definition (never rename or reuse an id: `cosmetic_unlocks` keeps it), give
 * it a source the server already grants (below), and list its art for the art ticket. The next
 * deploy backfills it for accounts that already earned it.
 */

/**
 * - `appearance`: a palette of the hero's class sprite (per hero; every class has every palette);
 * - `banner`: the banner style behind the account's heroes (per account);
 * - `crest`: the frame of the account's crest on profiles, boards and rosters (per account);
 * - `titleColour`: the colour of the title the account shows (per account);
 * - `title`: a title shown beside the name (chosen in Season honours, 5.3 / 6.6).
 */
export type CosmeticKind = 'appearance' | 'banner' | 'crest' | 'titleColour' | 'title';

export const COSMETIC_KINDS: readonly CosmeticKind[] = [
  'appearance',
  'banner',
  'crest',
  'titleColour',
  'title',
];

/** Where an equipped cosmetic of a kind lives: on one hero, or on the whole account. */
export function cosmeticScope(kind: CosmeticKind): 'hero' | 'account' {
  return kind === 'appearance' ? 'hero' : 'account';
}

/** Milestones a hero reaches (read from the hero's own level and progress flags). */
export type CosmeticMilestone =
  | { kind: 'characterLevel'; level: number }
  | { kind: 'bossDefeated'; boss: 'ashenWarden' | 'forgeTyrant' | 'hollowSovereign' }
  | { kind: 'cryptTier'; tier: number };

/**
 * Where a cosmetic comes from:
 * - `default`: every hero has it (the class's own colours);
 * - `event`: a tier of an event's reward track (6.6);
 * - `achievement`: granted with an achievement (a deed, 4.2; Forgeward contributors via 6.7's);
 * - `milestone`: a hero of the account reaches it (level, a boss slain, a crypt tier cleared);
 * - `season`: a season honour of at least `minTier` on any board (5.3);
 * - `exchange`: ticket 6.11, traded at the Forge for Gravewarden's Seals and Abbey silver earned in
 *   play (`COSMETIC_EXCHANGE` in `exchange.ts` holds the price; never real money).
 */
export type CosmeticSource =
  | { kind: 'default' }
  | { kind: 'event'; eventId: string }
  | { kind: 'achievement'; achievementId: string }
  | { kind: 'milestone'; milestone: CosmeticMilestone }
  | { kind: 'season'; minTier: PrestigeTier }
  | { kind: 'exchange' };

export interface CosmeticDefinition {
  /** `<kind>.<kebab-case name>`; stored in `cosmetic_unlocks.cosmetic_id`. */
  id: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  source: CosmeticSource;
}

/** The default appearance: the class's own colours, never stored (null = default). */
export const DEFAULT_APPEARANCE_ID = 'appearance.default';

export const COSMETICS: readonly CosmeticDefinition[] = [
  // --- 6.6: the Harvest of Bones reward track (ids kept) ---
  {
    id: 'banner.harvest-sheaf',
    kind: 'banner',
    name: 'Sheaf-and-Bone banner',
    description: 'A banner of bound wheat and a bleached jawbone, as the Reeve’s reapers carried.',
    source: { kind: 'event', eventId: 'harvestOfBones' },
  },
  {
    id: 'title-colour.bone-white',
    kind: 'titleColour',
    name: 'Bone-white',
    description: 'Your title in the pale of sun-bleached bone.',
    source: { kind: 'event', eventId: 'harvestOfBones' },
  },
  {
    id: 'title.reaper-of-the-harvest',
    kind: 'title',
    name: 'Reaper of the Harvest',
    description: 'For bringing in the whole Harvest of Bones.',
    source: { kind: 'event', eventId: 'harvestOfBones' },
  },
  // --- 6.8: hero appearances (palettes of every class) ---
  {
    id: DEFAULT_APPEARANCE_ID,
    kind: 'appearance',
    name: 'Own colours',
    description: 'The colours your hero set out in.',
    source: { kind: 'default' },
  },
  {
    id: 'appearance.grave-moss',
    kind: 'appearance',
    name: 'Grave-moss',
    description: 'Gear gone green with the damp of the crypt, as worn by those who came back up.',
    source: { kind: 'achievement', achievementId: 'gravewardenSlain' },
  },
  {
    id: 'appearance.ashen',
    kind: 'appearance',
    name: 'Ashen',
    description:
      'Every colour burnt to grey on the long road. Worn by heroes of the fortieth mark.',
    source: { kind: 'milestone', milestone: { kind: 'characterLevel', level: 40 } },
  },
  {
    id: 'appearance.ember',
    kind: 'appearance',
    name: 'Ember',
    description: 'Iron that still glows from the Tyrant’s forge.',
    source: { kind: 'milestone', milestone: { kind: 'bossDefeated', boss: 'forgeTyrant' } },
  },
  {
    id: 'appearance.midnight',
    kind: 'appearance',
    name: 'Midnight',
    description: 'The deep blue of the crypt’s lowest stair, where only the Heroic go.',
    source: { kind: 'milestone', milestone: { kind: 'cryptTier', tier: 4 } },
  },
  // --- 6.8: banner styles ---
  {
    id: 'banner.crypt-seal',
    kind: 'banner',
    name: 'Crypt-seal banner',
    description: 'The broken seal of the Nameless Crypt’s deepest door, sewn on black.',
    source: { kind: 'achievement', achievementId: 'cryptTier3' },
  },
  {
    id: 'banner.warden-flame',
    kind: 'banner',
    name: 'Warden-flame banner',
    description: 'The pale fire that burned over the Warden’s Watch until you put it out.',
    source: { kind: 'milestone', milestone: { kind: 'bossDefeated', boss: 'ashenWarden' } },
  },
  {
    id: 'banner.ember-standard',
    kind: 'banner',
    name: 'Ember standard',
    description: 'Raised over the Ashen Pass by those who cleared it.',
    source: { kind: 'achievement', achievementId: 'ashenPassBreaker' },
  },
  {
    id: 'banner.forgeward',
    kind: 'banner',
    name: 'Forgeward banner',
    description: 'Hammer and bellows, for the hands that rebuilt the Forgeward Outpost.',
    source: { kind: 'achievement', achievementId: 'forgewardBuilder' },
  },
  {
    id: 'banner.season-laurel',
    kind: 'banner',
    name: 'Laurel banner',
    description: 'A wreath of ash-laurel, for anyone honoured at a season’s end.',
    source: { kind: 'season', minTier: 'veteran' },
  },
  // --- 6.8: crest styles ---
  {
    id: 'crest.iron',
    kind: 'crest',
    name: 'Iron crest',
    description: 'A plain riveted rim, earned by ten contracts honestly done.',
    source: { kind: 'achievement', achievementId: 'contracts10' },
  },
  {
    id: 'crest.bone',
    kind: 'crest',
    name: 'Bone crest',
    description: 'Ribs and knuckles bound in wire, from the guild boss laid to rest.',
    source: { kind: 'achievement', achievementId: 'guildBossLaidToRest' },
  },
  {
    id: 'crest.ember',
    kind: 'crest',
    name: 'Ember crest',
    description: 'A rim hammered hot, for raising a piece to +10 at the forge.',
    source: { kind: 'achievement', achievementId: 'forgePlus10' },
  },
  {
    id: 'crest.gilt',
    kind: 'crest',
    name: 'Gilt crest',
    description: 'Gold leaf on the rim, for an Exalted honour or better at a season’s end.',
    source: { kind: 'season', minTier: 'exalted' },
  },
  // --- 6.8: title colours ---
  {
    id: 'title-colour.ember',
    kind: 'titleColour',
    name: 'Ember',
    description: 'Your title in the orange of a Legendary find.',
    source: { kind: 'achievement', achievementId: 'firstLegendary' },
  },
  {
    id: 'title-colour.verdigris',
    kind: 'titleColour',
    name: 'Verdigris',
    description: 'Your title in old copper-green, for fifty contracts done.',
    source: { kind: 'achievement', achievementId: 'contracts50' },
  },
  {
    id: 'title-colour.royal',
    kind: 'titleColour',
    name: 'Royal',
    description: 'Your title in deep royal purple, for a season’s Champion.',
    source: { kind: 'season', minTier: 'champion' },
  },
  // Ticket 8.2: the Hollow Sovereign's milestone (a title colour: CSS only, no new art).
  {
    id: 'title-colour.hollow-pale',
    kind: 'titleColour',
    name: 'Hollow pale',
    description: 'Your title in the cold grey of the Sovereign’s crown, for those who took it.',
    source: { kind: 'milestone', milestone: { kind: 'bossDefeated', boss: 'hollowSovereign' } },
  },
  // --- 6.11: the Forge's exchange (Seals and Abbey silver; existing art, tinted in code) ---
  {
    id: 'title-colour.seal-wax',
    kind: 'titleColour',
    name: 'Seal-wax',
    description: 'Your title in the dark red of the wax the Gravewarden pressed his seals in.',
    source: { kind: 'exchange' },
  },
  {
    id: 'title-colour.abbey-silver',
    kind: 'titleColour',
    name: 'Abbey silver',
    description: 'Your title in the tarnished silver of the drowned abbey’s treasury.',
    source: { kind: 'exchange' },
  },
  {
    id: 'banner.silvered-seal',
    kind: 'banner',
    name: 'Silvered seal banner',
    description: 'The crypt’s broken seal again, stitched in abbey-silver thread.',
    source: { kind: 'exchange' },
  },
  {
    id: 'crest.abbey-silver',
    kind: 'crest',
    name: 'Abbey-silver crest',
    description: 'A riveted rim beaten from drowned-abbey silver, still dull with the water.',
    source: { kind: 'exchange' },
  },
  {
    id: 'crest.seal-wax',
    kind: 'crest',
    name: 'Wax-sealed crest',
    description: 'A rim dipped in the crypt’s red sealing wax and pressed while warm.',
    source: { kind: 'exchange' },
  },
];

const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));

export function findCosmetic(id: string): CosmeticDefinition | undefined {
  return BY_ID.get(id);
}

export function isCosmeticId(id: string): boolean {
  return BY_ID.has(id);
}

/** Every catalogued cosmetic can be shown since the collection book (6.8). */
export function cosmeticShownToday(c: Pick<CosmeticDefinition, 'kind'>): boolean {
  return COSMETIC_KINDS.includes(c.kind);
}

/** Owned by everyone without a grant (never stored). */
export function isDefaultCosmetic(id: string): boolean {
  return findCosmetic(id)?.source.kind === 'default';
}

/** The cosmetics granted with these achievements. */
export function cosmeticsForAchievements(achievementIds: Iterable<string>): string[] {
  const got = new Set(achievementIds);
  return COSMETICS.filter(
    (c) => c.source.kind === 'achievement' && got.has(c.source.achievementId),
  ).map((c) => c.id);
}

/** The hero facts a milestone reads (the hero's row after the change). */
export interface MilestoneHero {
  level: number;
  progress: {
    gravewardenDefeated?: boolean;
    cryptTierCleared?: number;
    ashenWardenDefeated?: boolean;
    forgeTyrantDefeated?: boolean;
    hollowSovereignDefeated?: boolean;
  };
}

export function milestoneReached(m: CosmeticMilestone, hero: MilestoneHero): boolean {
  switch (m.kind) {
    case 'characterLevel':
      return hero.level >= m.level;
    case 'bossDefeated':
      if (m.boss === 'ashenWarden') return hero.progress.ashenWardenDefeated === true;
      if (m.boss === 'hollowSovereign') return hero.progress.hollowSovereignDefeated === true;
      return hero.progress.forgeTyrantDefeated === true;
    case 'cryptTier': {
      const stored = Number.isInteger(hero.progress.cryptTierCleared)
        ? hero.progress.cryptTierCleared!
        : 0;
      const tier = Math.max(stored, hero.progress.gravewardenDefeated === true ? 1 : 0);
      return tier >= m.tier;
    }
  }
}

/** The milestone cosmetics this hero has reached. */
export function milestoneCosmeticsEarned(hero: MilestoneHero): string[] {
  return COSMETICS.filter(
    (c) => c.source.kind === 'milestone' && milestoneReached(c.source.milestone, hero),
  ).map((c) => c.id);
}

const tierRank = (t: PrestigeTier) => PRESTIGE_TIER_IDS.indexOf(t);

/** The season cosmetics these honours (an account's season award tiers) earn. */
export function seasonCosmeticsEarned(tiers: Iterable<PrestigeTier>): string[] {
  let best = Infinity;
  for (const t of tiers) best = Math.min(best, tierRank(t));
  if (!Number.isFinite(best)) return [];
  return COSMETICS.filter(
    (c) => c.source.kind === 'season' && best <= tierRank(c.source.minTier),
  ).map((c) => c.id);
}

/** The cosmetics a kind offers in the book, in catalogue order. */
export function cosmeticsOfKind(kind: CosmeticKind): CosmeticDefinition[] {
  return COSMETICS.filter((c) => c.kind === kind);
}

/**
 * Why an equip is refused, or null when `id` may be equipped in `kind`'s slot by an owner of
 * `owned` (the account's unlock ids). `null` id = the plain look (always allowed).
 */
export function equipProblem(
  kind: Exclude<CosmeticKind, 'title'>,
  id: string | null,
  owned: ReadonlySet<string>,
): 'unknown' | 'wrong_kind' | 'not_owned' | null {
  if (id === null) return null;
  const c = findCosmetic(id);
  if (!c) return 'unknown';
  if (c.kind !== kind) return 'wrong_kind';
  if (c.source.kind === 'default') return null;
  return owned.has(id) ? null : 'not_owned';
}
