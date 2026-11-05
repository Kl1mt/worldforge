import { GUIDE_STEP_IDS, type GuideStepId } from '@worldforge/game-core';
import type { GameRoute } from '../lib/route';

/** What the client can see of the first session, all from server state (ticket 2.7). */
export interface GuideObservation {
  route: GameRoute;
  /** An activity is running, or foes were already killed this visit. */
  farming: boolean;
  /** Items in the pack plus items worn. */
  itemCount: number;
  equippedCount: number;
}

/** The guide steps the observation shows done (the hero exists inside the game shell). */
export function observedSteps(o: GuideObservation): GuideStepId[] {
  const done: GuideStepId[] = ['character'];
  if (o.farming || o.itemCount > 0) done.push('farm');
  if (o.itemCount > 0) done.push('drop');
  if (o.equippedCount > 0) done.push('equip');
  if (o.route === 'tavern') done.push('tavern');
  return done;
}

export interface GuideStepCopy {
  id: GuideStepId;
  title: string;
  /** One or two plain sentences on what to do. */
  text: string;
  /** Where the step happens, unless the player is already there. */
  go: { route: GameRoute; label: string } | null;
}

/** Copy of each step; `hero` is the character's name. */
export function guideStepCopy(id: GuideStepId, hero: string): GuideStepCopy {
  switch (id) {
    case 'character':
      return { id, title: 'Forge a hero', text: `${hero} stands ready.`, go: null };
    case 'farm':
      return {
        id,
        title: 'Send your hero out',
        text: `Press “Farm Abandoned Fields”. ${hero} fights on their own, even while you are away.`,
        go: { route: 'area', label: 'To the fields' },
      };
    case 'drop':
      return {
        id,
        title: 'Wait for the first drop',
        text: 'Foes drop gear now and then. The Chronicle names it and it lands in your Pack.',
        go: { route: 'area', label: 'Watch the fight' },
      };
    case 'equip':
      return {
        id,
        title: 'Equip it',
        text: 'Open the Pack, pick the item, check the ▲ gains and press Equip.',
        go: { route: 'inventory', label: 'Open the pack' },
      };
    case 'tavern':
      return {
        id,
        title: 'Visit the Tavern',
        text: 'The Tavern in town pays for quests and contracts. Take one; it counts while you farm.',
        go: { route: 'tavern', label: 'To the Tavern' },
      };
  }
}

export const GUIDE_LENGTH = GUIDE_STEP_IDS.length;

/** The offline cap in words: "3 hours", "1 hour", "90 min". */
export function capText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${minutes} min`;
}
