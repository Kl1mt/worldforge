/**
 * Cosmetics (ticket 6.6, docs/EVENTS.md "Cosmetics"). A small, additive catalogue that ticket 6.8's
 * collection book will extend: every cosmetic has an id, a kind, a name and where it comes from.
 * Cosmetics change no number in the game: nothing in the combat, loot, farming, dungeon, scoring or
 * PvP rules reads this module (a test scans the imports).
 */

/**
 * - `title`: a title shown beside the hero's name (chosen like a season title, `HonoursPanel`);
 * - `banner`: a banner style (shown once the collection book opens, 6.8);
 * - `titleColour`: the colour of the shown title (6.8).
 */
export type CosmeticKind = 'title' | 'banner' | 'titleColour';

export const COSMETIC_KINDS: readonly CosmeticKind[] = ['title', 'banner', 'titleColour'];

/** Where a cosmetic comes from (6.8 adds deeds, seasons and milestones). */
export type CosmeticSource = { kind: 'event'; eventId: string };

export interface CosmeticDefinition {
  /** `<kind>.<kebab-case name>`; stored in `cosmetic_unlocks.cosmetic_id`. */
  id: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  source: CosmeticSource;
}

export const COSMETICS: readonly CosmeticDefinition[] = [
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
];

const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));

export function findCosmetic(id: string): CosmeticDefinition | undefined {
  return BY_ID.get(id);
}

export function isCosmeticId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Whether a cosmetic can be shown before the collection book (6.8): titles can, through the
 * season-title picker; banners and title colours wait for the book.
 */
export function cosmeticShownToday(c: Pick<CosmeticDefinition, 'kind'>): boolean {
  return c.kind === 'title';
}
