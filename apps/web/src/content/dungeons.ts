import type { DungeonId } from '@worldforge/game-core';
import type { GameRoute } from '../lib/route';

/**
 * Ticket 4.8: the words of each dungeon screen. The crypt (ticket 2.5/3.6) and the Warden's Watch
 * share one screen (`DungeonScreen`); only these lines differ.
 */
export interface DungeonWords {
  route: Extract<GameRoute, 'crypt' | 'watch' | 'tyrant'>;
  /** "the crypt", in running text. */
  place: string;
  loading: string;
  /** The idle scene's description (the boss waits). */
  waiting: string;
  /** HUD clock label, e.g. "In the crypt 1:24". */
  inside: string;
  logTitle: string;
  logEmpty: string;
  doorTitle: string;
  barredTitle: string;
  runTitle: string;
  /** While a run plays out. */
  runNote: string;
  enter: string;
  entering: string;
  again: string;
  clearedLine: string;
  fallenLine: string;
  reckoning: string;
  wonTitle: string;
  lostTitle: string;
  /** The boss's hoard while it is ready ("… once per 20 hours."). */
  hoard: string;
  /** The boss's hoard on cooldown; `{when}` is the time it returns. */
  hoardBack: string;
  leaving: string;
  /** Log lines. */
  bossEnter: string;
  enrage: string;
  /** Ticket 6.2: the boss's shell breaks (`shellBroken`); only bosses with a shell. */
  shellBroken?: string;
  /** Ticket 6.2: a heavy blow lands (`enemyAttack` with `heavy`); `{damage}` is the hit. */
  heavyBlow?: string;
  won: string;
  lost: string;
  /** Another hero of the account is in this dungeon. */
  otherHero: string;
}

export const DUNGEON_WORDS: Readonly<Record<DungeonId, DungeonWords>> = {
  namelessCrypt: {
    route: 'crypt',
    place: 'the crypt',
    loading: 'Lighting a torch at the crypt door…',
    waiting: 'The Nameless Crypt. The Gravewarden waits in the dark.',
    inside: 'In the crypt',
    logTitle: 'Echoes from below',
    logEmpty: 'Torchlight on wet stone. The stair goes down.',
    doorTitle: 'Before you descend',
    barredTitle: 'The door is barred',
    runTitle: 'Delving',
    runNote: 'The fight below plays out on its own.',
    enter: 'Descend into the crypt',
    entering: 'Descending…',
    again: 'Descend again',
    clearedLine: 'Silence below. The warden’s chamber stands open.',
    fallenLine: 'Your hero has fallen back to the stair. Take what you carried out.',
    reckoning: 'The crypt’s reckoning',
    wonTitle: 'The Gravewarden falls',
    lostTitle: 'The crypt keeps its warden',
    hoard:
      'The warden’s hoard: a Gravewarden Seal and two items of its own. It is shared by every depth, once per 20 hours.',
    hoardBack: 'The warden’s hoard returns {when}, at every depth. You can still fight it.',
    leaving:
      'Your hero leaves the fields while in the crypt. A fall keeps what you took on the way down.',
    bossEnter: 'The Gravewarden’s chamber. The door grinds shut behind you.',
    enrage: 'The Gravewarden enrages! Its blows fall faster and harder.',
    won: 'The Gravewarden is no more. The crypt falls silent.',
    lost: 'The crypt keeps its warden. You crawl back to the light.',
    otherHero: 'Another of your heroes is in the crypt. Switch to them to finish that run.',
  },
  ashenWatch: {
    route: 'watch',
    place: 'the watch',
    loading: 'Climbing the burnt stair…',
    waiting: 'The Warden’s Watch. The Ashen Warden keeps his fire at the top of the tower.',
    inside: 'On the watch',
    logTitle: 'Smoke from the tower',
    logEmpty: 'Ash on every step. The fire burns above.',
    doorTitle: 'Before you climb',
    barredTitle: 'The stair is barred',
    runTitle: 'On the watch',
    runNote: 'The fight at the top of the tower plays out on its own.',
    enter: 'Climb to the warden',
    entering: 'Climbing…',
    again: 'Climb again',
    clearedLine: 'The fire is out. The warden’s post stands empty.',
    fallenLine: 'Your hero has fallen back down the stair. The warden keeps his watch.',
    reckoning: 'The watch’s reckoning',
    wonTitle: 'The Ashen Warden falls',
    lostTitle: 'The warden keeps his watch',
    hoard: 'The warden’s hoard: two items from his armoury and his purse, once per 20 hours.',
    hoardBack: 'The warden’s hoard returns {when}. You can still fight him.',
    leaving: 'Your hero leaves the fields while on the watch. A fall costs nothing but the climb.',
    bossEnter: 'The top of the watchtower. The Ashen Warden turns from his fire.',
    enrage: 'The Ashen Warden’s blade catches fire! His blows fall faster and harder.',
    won: 'The Ashen Warden falls. The fire on the tower goes out.',
    lost: 'The warden keeps his watch. You stumble down through the smoke.',
    otherHero: 'Another of your heroes is on the watch. Switch to them to finish that run.',
  },
  // Ticket 6.2: the Cinderwastes' region boss at the bottom of the Cinder Depths.
  tyrantsForge: {
    route: 'tyrant',
    place: 'the forge',
    loading: 'Descending through the slag…',
    waiting:
      'The Tyrant’s Forge. Its furnace roars at the bottom of the Depths; the Forge Tyrant works its anvil.',
    inside: 'In the forge',
    logTitle: 'Sparks from the furnace',
    logEmpty: 'Heat rises from below. A hammer rings, slow and steady.',
    doorTitle: 'Before you descend',
    barredTitle: 'The furnace door is barred',
    runTitle: 'In the forge',
    runNote: 'The fight at the anvil plays out on its own.',
    enter: 'Descend to the anvil',
    entering: 'Descending…',
    again: 'Descend again',
    clearedLine: 'The hammer is still. The furnace burns low.',
    fallenLine: 'Your hero has fallen back into the slag. The Tyrant returns to his anvil.',
    reckoning: 'The forge’s reckoning',
    wonTitle: 'The Forge Tyrant falls',
    lostTitle: 'The Tyrant keeps his forge',
    hoard:
      'The Tyrant’s hoard: two pieces from his anvil, his purse and a Tyrant’s Ember, once per 20 hours. Hoard items are always bound to you.',
    hoardBack: 'The Tyrant’s hoard returns {when}. You can still fight him.',
    leaving:
      'Your hero leaves the fields while in the forge. A fall costs nothing but the descent.',
    bossEnter: 'The furnace floor. The Forge Tyrant sets down his tongs and lifts his hammer.',
    enrage: 'The furnace roars white! The Tyrant’s blows fall faster and harder.',
    shellBroken: 'His slag armour cracks and falls away. Your blows bite now.',
    heavyBlow: 'The Tyrant’s hammer comes down for {damage}!',
    won: 'The Forge Tyrant falls across his anvil. The furnace dims.',
    lost: 'The Tyrant keeps his forge. You crawl back up through the slag.',
    otherHero: 'Another of your heroes is in the forge. Switch to them to finish that run.',
  },
};

/** The dungeon of a screen route. */
export const DUNGEON_OF_ROUTE = {
  crypt: 'namelessCrypt',
  watch: 'ashenWatch',
  tyrant: 'tyrantsForge',
} as const satisfies Record<DungeonWords['route'], DungeonId>;
