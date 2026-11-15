import { and, eq } from 'drizzle-orm';
import {
  LOADOUT_PRESETS,
  defaultLoadout,
  effectiveLoadout,
  isDefaultLoadout,
  type ClassId,
  type Loadout,
  type WorldProgress,
} from '@worldforge/game-core';
import { characterLoadouts, type Character } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/**
 * Ticket 9.2 (docs/SKILLS.md "Loadouts"): a hero's loadout presets and the one in force. Stored
 * rows are never trusted: every read goes through game-core `effectiveLoadout` with the hero's
 * level and deeds, so a preset the hero can no longer field reads as the default loadout.
 */

/** A preset as stored (null = no row: the default loadout). */
export interface StoredPreset {
  preset: number;
  loadout: Loadout | null;
}

export function presetNumbers(): number[] {
  return Array.from({ length: LOADOUT_PRESETS }, (_, i) => i + 1);
}

export function heroFacts(hero: Pick<Character, 'level' | 'progress'>) {
  return { level: hero.level, progress: hero.progress as Partial<WorldProgress> };
}

/** The hero's stored presets, 1–3 in order (null where no row). */
export async function loadPresets(db: Executor, characterId: string): Promise<StoredPreset[]> {
  const rows = await db
    .select()
    .from(characterLoadouts)
    .where(eq(characterLoadouts.characterId, characterId));
  return presetNumbers().map((preset) => {
    const row = rows.find((r) => r.preset === preset);
    return {
      preset,
      loadout: row ? { actives: [...row.actives], passive: row.passive ?? null } : null,
    };
  });
}

/** One stored preset (null: no row). */
export async function loadPreset(
  db: Executor,
  characterId: string,
  preset: number,
): Promise<Loadout | null> {
  const [row] = await db
    .select()
    .from(characterLoadouts)
    .where(
      and(eq(characterLoadouts.characterId, characterId), eq(characterLoadouts.preset, preset)),
    );
  return row ? { actives: [...row.actives], passive: row.passive ?? null } : null;
}

/**
 * The loadout the hero fights with now: the preset in force, checked against the hero's unlocks
 * (default when there is none or it cannot be fielded). Read under the character lock by
 * settlement and every fight, so a window never mixes two loadouts.
 */
export async function activeLoadout(
  db: Executor,
  hero: Pick<Character, 'id' | 'classId' | 'level' | 'progress' | 'loadoutPreset'>,
): Promise<Loadout> {
  const stored = await loadPreset(db, hero.id, hero.loadoutPreset ?? 1);
  return effectiveLoadout(hero.classId, stored, heroFacts(hero));
}

/** The loadout for a game-core input: undefined for the default (today's path, nothing to pass). */
export function chosen(classId: ClassId, loadout: Loadout): Loadout | undefined {
  return isDefaultLoadout(classId, loadout) ? undefined : loadout;
}

/** Spread into a snapshot: `{ loadout }` for a chosen loadout, nothing for the default. */
export function withLoadout(classId: ClassId, loadout: Loadout): { loadout?: Loadout } {
  return isDefaultLoadout(classId, loadout)
    ? {}
    : { loadout: { actives: [...loadout.actives], passive: loadout.passive ?? null } };
}

/** A loadout in a fixed shape (three slots, passive or null), as stored and compared. */
export function canonicalLoadout(classId: ClassId, loadout: Loadout | null): Loadout {
  const l = loadout ?? defaultLoadout(classId);
  const actives = [...l.actives];
  while (actives.length < 3) actives.push(null);
  return { actives: actives.slice(0, 3), passive: l.passive ?? null };
}

export const sameLoadout = (a: Loadout, b: Loadout) =>
  JSON.stringify([a.actives, a.passive ?? null]) === JSON.stringify([b.actives, b.passive ?? null]);
