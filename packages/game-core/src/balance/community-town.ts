import {
  COMMUNITY_PROJECTS,
  COMMUNITY_PROJECT_CONFIG,
  stageCap,
  type CommunityProjectConfig,
  type CommunityProjectDefinition,
  type ProjectResource,
  type ResourceAmounts,
} from '../world/projects.js';

/**
 * A day-by-day model of a town giving to the community projects (ticket B.3, extended by 6.7;
 * docs/COMMUNITY.md "How long a stage takes" and "The Forgeward Outpost"). Test support only: it
 * plays the real caps (`stageCap`, growing with the stage's age) against what each player can
 * spare a day.
 *
 * Supplies per day (the realistic player, docs/ECONOMY.md): gathering is ~600 cycles an hour at
 * 5–6 % per material (≈ 30–36 units an hour), five visits a day credit ~15 h; a player spares about
 * a third of that day's gathering of its area's materials and a quarter (newcomer) or a third
 * (veteran, endgame) of its gold; materials outside its area come from salvage and stock (smaller).
 * Boss materials are kept until given (`STASHED`): seals one per crypt hoard (20 h cooldown, so one
 * a day), Tyrant's Embers one per Forge hoard, half a day on average for an endgame player (not
 * every run is won, and Item Awakening wants three).
 */
export type Supply = ResourceAmounts;

/** Levels 9–16: Crowwood to Blackwater, ~1,000 gold an hour. */
export const NEWCOMER: Supply = {
  gold: 4_000,
  timber: 150,
  rawHide: 150,
  ashwort: 150,
  ironOre: 80,
  soulShard: 60,
};
/** The Abbey, the crypt and the Ashen Pass: ~1,650–2,400 gold an hour. */
export const VETERAN: Supply = {
  gold: 10_000,
  timber: 60,
  rawHide: 60,
  ashwort: 60,
  ironOre: 250,
  soulShard: 60,
  abbeySilver: 25,
  gravewardenSeal: 1,
};
/**
 * Ticket 6.7: the Cinderwastes (the Verge, the Depths, the Tyrant's Forge): ~3,000 gold an hour,
 * ore and shards from the region's gathering, silver from stock.
 */
export const ENDGAME: Supply = {
  gold: 15_000,
  timber: 30,
  rawHide: 30,
  ashwort: 30,
  ironOre: 170,
  soulShard: 170,
  abbeySilver: 5,
  gravewardenSeal: 1,
  tyrantsEmber: 0.5,
};
/**
 * Ticket 8.2: the Hollow Reach (the Pale Marches and, once open, the Deep): ~5,000 gold an hour
 * with Marches Legendaries (`tools/balance/hollow-deep.ts farm`), ore and shards from the region's
 * gathering, silver from stock, and a Tyrant's Ember on half the days (the Forge is still on the
 * way; most Reach heroes still run it for its hoard).
 */
export const REACH: Supply = {
  gold: 22_000,
  timber: 20,
  rawHide: 20,
  ashwort: 20,
  ironOre: 180,
  soulShard: 110,
  abbeySilver: 4,
  gravewardenSeal: 1,
  tyrantsEmber: 0.5,
};
export const ENDLESS: Supply = Object.fromEntries(
  [
    'gold',
    'timber',
    'rawHide',
    'ironOre',
    'ashwort',
    'soulShard',
    'abbeySilver',
    'gravewardenSeal',
    'tyrantsEmber',
  ].map((r) => [r, 1e9]),
);

/** Boss materials: kept from day to day until given. */
const STASHED: readonly ProjectResource[] = ['gravewardenSeal', 'tyrantsEmber'];

/** B.3's town of n active players: a third veterans (at least one), the rest newcomers. */
export const town = (n: number): Supply[] =>
  Array.from({ length: n }, (_, i) => (i < Math.max(1, Math.round(n / 3)) ? VETERAN : NEWCOMER));

/**
 * Ticket 6.7's larger town: a sixth endgame players (at least one), a third veterans, the rest
 * newcomers. Endgame players give first in the rotation on day 0 (the worst case for monopoly).
 */
export const largeTown = (n: number): Supply[] => {
  const end = Math.max(1, Math.round(n / 6));
  const vet = Math.round(n / 3);
  return Array.from({ length: n }, (_, i) =>
    i < end ? ENDGAME : i < end + vet ? VETERAN : NEWCOMER,
  );
};

/**
 * Ticket 8.2's town when the lanterns of the deep open: a tenth Hollow Reach heroes (at least one),
 * a tenth Cinderwastes heroes, a third veterans, the rest newcomers. Reach heroes give first on
 * day 0 (the worst case for monopoly). Only heroes past the Forge Tyrant hold embers.
 */
export const reachTown = (n: number): Supply[] => {
  const reach = Math.max(1, Math.round(n / 10));
  const end = Math.round(n / 10);
  const vet = Math.round(n / 3);
  return Array.from({ length: n }, (_, i) =>
    i < reach ? REACH : i < reach + end ? ENDGAME : i < reach + end + vet ? VETERAN : NEWCOMER,
  );
};

export interface StageResult {
  project: string;
  stage: string;
  /** Day (0-based) of the stage's first gift and the day it was finished. */
  firstDay: number;
  doneOn: number;
  /** Distinct players who gave to it. */
  givers: number;
  /** Most of any need one player gave in one day, as a share of the need (any day; first day). */
  maxDayShare: number;
  maxFirstDayShare: number;
  /** The largest share of the whole stage (all needs, each need weighted equally) one player gave. */
  topGiverShare: number;
}

/**
 * Plays `days` days: every day each player, in a rotating order, gives what the current stage
 * still needs, up to its cap that day and what it can spare (unspent spare is not carried over,
 * except `STASHED` boss materials, given in whole units). A stage finished mid-day opens the next
 * one the same day, with its own caps (as on the server). `projects` are played in order.
 */
export function playTown(
  players: Supply[],
  config: CommunityProjectConfig = COMMUNITY_PROJECT_CONFIG,
  projects: readonly CommunityProjectDefinition[] = COMMUNITY_PROJECTS,
  days = 90,
): StageResult[] {
  const out: StageResult[] = [];
  const stash = players.map(() => ({}) as Record<string, number>);
  let p = 0;
  let s = 0;
  let firstDay: number | null = null;
  let delivered: Record<string, number> = {};
  let givers = new Set<number>();
  let byGiver = new Map<number, number>();
  let maxDayShare = 0;
  let maxFirstDayShare = 0;
  for (let day = 0; day < days && p < projects.length; day++) {
    const left = players.map((sup, i) => {
      const today: Record<string, number> = { ...sup } as Record<string, number>;
      for (const r of STASHED) {
        stash[i]![r] = (stash[i]![r] ?? 0) + (sup[r] ?? 0);
        today[r] = Math.floor(stash[i]![r]! + 1e-9);
      }
      return today;
    });
    const givenToday = new Map<string, number>();
    for (let k = 0; k < players.length && p < projects.length; k++) {
      const i = (k + day) % players.length;
      // A player gives to every stage it can reach today (several, if one finishes).
      for (let guard = 0; guard < 10 && p < projects.length; guard++) {
        const project = projects[p]!;
        const stage = project.stages[s]!;
        const age = firstDay === null ? 0 : day - firstDay;
        let gave = false;
        for (const need of stage.needs) {
          const r = need.resource;
          const key = `${p}:${s}:${i}:${r}`;
          const cap = stageCap(stage, r, age, config) - (givenToday.get(key) ?? 0);
          const amount = Math.min(cap, need.amount - (delivered[r] ?? 0), left[i]![r] ?? 0);
          if (amount <= 0) continue;
          gave = true;
          delivered[r] = (delivered[r] ?? 0) + amount;
          left[i]![r] = left[i]![r]! - amount;
          if (STASHED.includes(r)) stash[i]![r]! -= amount;
          givenToday.set(key, (givenToday.get(key) ?? 0) + amount);
          byGiver.set(i, (byGiver.get(i) ?? 0) + amount / need.amount / stage.needs.length);
          const share = (givenToday.get(key) ?? 0) / need.amount;
          maxDayShare = Math.max(maxDayShare, share);
          if (age === 0) maxFirstDayShare = Math.max(maxFirstDayShare, share);
        }
        if (!gave) break;
        if (firstDay === null) firstDay = day;
        givers.add(i);
        if (!stage.needs.every((n) => (delivered[n.resource] ?? 0) >= n.amount)) break;
        out.push({
          project: project.id,
          stage: stage.id,
          firstDay: firstDay,
          doneOn: day,
          givers: givers.size,
          maxDayShare,
          maxFirstDayShare,
          topGiverShare: Math.max(...byGiver.values()),
        });
        s += 1;
        if (s >= project.stages.length) {
          p += 1;
          s = 0;
        }
        firstDay = null;
        delivered = {};
        givers = new Set();
        byGiver = new Map();
        maxDayShare = 0;
        maxFirstDayShare = 0;
      }
    }
  }
  return out;
}
