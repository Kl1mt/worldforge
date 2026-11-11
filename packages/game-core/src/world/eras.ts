import type { WorldFlagId, WorldFlags } from './projects.js';

/**
 * World eras (ticket 6.7, docs/WORLD.md "Eras of Graumark"): the long-term story of the town, read
 * from the world flags that completed community projects set. An era is **presentation only**: a
 * name, a title for the town header, a tint key for the town picture, banner words, the Tavern's
 * ambient line and the town crier's calls. Nothing in combat, loot, prices or progress reads it
 * (asserted in `eras.test.ts`); a power change must come from a project's own flag rule instead.
 *
 * The era is the **latest** era whose flag is set (flags are never removed by play), so it only
 * moves forward as projects complete; a world that already finished projects starts in the era
 * they earned (on live: the Warehouse and the Ashen Pass are done, so the Rekindling).
 *
 * Never rename or reuse an era id (telemetry and audit rows keep it); append new eras at the end.
 */

export const WORLD_ERA_IDS = [
  'longDusk',
  'ashenSiege',
  'rekindling',
  'forgewardAge',
  // Ticket 8.2: after the lanterns of the deep.
  'lanternVigil',
] as const;
export type WorldEraId = (typeof WORLD_ERA_IDS)[number];

export interface WorldEraDefinition {
  id: WorldEraId;
  /** "The Ashen Siege". */
  name: string;
  /** The small title in the town header: "Era of the Ashen Siege". */
  title: string;
  /** The world flag that begins it (null: the first era, before any project). */
  beganBy: WorldFlagId | null;
  /** One line on what the town is going through. */
  tagline: string;
  /** What the banners over the street say (presentation; the web draws them in CSS). */
  banner: string;
  /** The Tavern's ambient line under its title. */
  tavern: string;
  /** The town crier's calls, shown one a day in turn. At least one. */
  crier: readonly string[];
}

export const WORLD_ERAS: readonly WorldEraDefinition[] = [
  {
    id: 'longDusk',
    name: 'The Long Dusk',
    title: 'Era of the Long Dusk',
    beganBy: null,
    tagline: 'The fields died and the light went with them. Graumark holds on.',
    banner: 'No banners fly; the poles stand bare.',
    tavern:
      'Smoke, spilt ale and a board full of nails. Few drink here now; whoever needs a sword pins a note, and the keeper pays out when the work is done.',
    crier: [
      'Hear ye: the old storehouse needs mending, and the town needs hands!',
      'Hear ye: keep the lamps lit and the doors barred after dark.',
    ],
  },
  {
    id: 'ashenSiege',
    name: 'The Ashen Siege',
    title: 'Era of the Ashen Siege',
    beganBy: 'warehouseRestored',
    tagline: 'The storehouse stands again, but ash falls from the pass and the dead walk closer.',
    banner: 'Grey pennants of the watch hang from the storehouse eaves.',
    tavern:
      'Smoke, spilt ale and a board full of nails. Talk is all of the pass and what comes down it; whoever needs a sword pins a note here.',
    crier: [
      'Hear ye: the Warehouse is open; keep what the road gives you!',
      'Hear ye: scouts wanted for the Ashen Pass. Bring silver and seals!',
    ],
  },
  {
    id: 'rekindling',
    name: 'The Rekindling',
    title: 'Era of the Rekindling',
    beganBy: 'ashenPassCleared',
    tagline: 'The pass is broken open. Beyond it the Cinderwastes glow, and the town dares again.',
    banner: 'Ember-red pennants fly over the street for the heroes of the pass.',
    tavern:
      'Smoke, spilt ale and a board full of nails. The hearth burns high again; traders from over the pass crowd the benches, and the keeper pays out when the work is done.',
    crier: [
      'Hear ye: the road through the Ashen Pass is open to all who dare it!',
      'Hear ye: the Cinderwastes burn beyond the pass. Who will build there?',
      'Hear ye: the forgeward fort lies in ruins past the pass. The town works want gold and ore!',
    ],
  },
  {
    id: 'forgewardAge',
    name: 'The Forgeward Age',
    title: 'Era of the Forgeward Age',
    beganBy: 'forgewardRaised',
    tagline: 'The beacon burns on the forgeward tower, and Graumark looks out over the wastes.',
    banner: 'Brass-and-ember banners of the Forgeward hang the length of the street.',
    tavern:
      'Smoke, spilt ale and a board full of nails. Outpost riders bring word from the wastes, and the beacon’s glow shows through the shutters; the keeper pays out when the work is done.',
    crier: [
      'Hear ye: the forgeward beacon is lit! The Forge works the Tyrant’s fire for less.',
      'Hear ye: the Forgeward Outpost keeps watch over the Cinderwastes. Ride safe!',
      'Hear ye: past the Tyrant’s furnace the Hollow Deep waits in the dark. The town works want lantern-iron!',
    ],
  },
  {
    // Ticket 8.2: the lanterns of the deep are lit; the Hollow Deep and its throne are open.
    id: 'lanternVigil',
    name: 'The Lantern Vigil',
    title: 'Era of the Lantern Vigil',
    beganBy: 'deepLanternsLit',
    tagline:
      'A road of lanterns hangs down into the Hollow Deep, and Graumark keeps watch over it.',
    banner: 'Pale lantern-cloth banners hang from every eave, a candle behind each.',
    tavern:
      'Smoke, spilt ale and a board full of nails. Lantern-keepers come up from the deep grey with dust and stories; a lamp burns in every window, and the keeper pays out when the work is done.',
    crier: [
      'Hear ye: the lanterns of the deep are lit! The road down into the Hollow Deep is open.',
      'Hear ye: a throne stands at the bottom of the deep. Who will take the Sovereign’s crown?',
      'Hear ye: the lantern smithy works crown-iron for less. Bring your shards!',
    ],
  },
];

export function getWorldEra(id: WorldEraId): WorldEraDefinition {
  return WORLD_ERAS.find((e) => e.id === id)!;
}

export function isWorldEraId(value: unknown): value is WorldEraId {
  return typeof value === 'string' && (WORLD_ERA_IDS as readonly string[]).includes(value);
}

/** The world's era: the latest era whose flag is set (the first era without any). */
export function worldEra(flags: Partial<WorldFlags> | null | undefined): WorldEraDefinition {
  for (let i = WORLD_ERAS.length - 1; i > 0; i--) {
    const era = WORLD_ERAS[i]!;
    if (era.beganBy !== null && flags?.[era.beganBy] === true) return era;
  }
  return WORLD_ERAS[0]!;
}

/** The era's index (0 = the first): the order eras come in. */
export function worldEraIndex(id: WorldEraId): number {
  return WORLD_ERA_IDS.indexOf(id);
}

/** The crier's call for a UTC day (`YYYY-MM-DD`): one a day, in turn (stable for the day). */
export function eraCrierLine(era: WorldEraDefinition, day: string): string {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const i = Number.isFinite(n) ? ((n % era.crier.length) + era.crier.length) % era.crier.length : 0;
  return era.crier[i]!;
}
